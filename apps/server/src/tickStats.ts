import { SIM, TICK_HISTORY_SECONDS } from '@rune/shared';

/**
 * Tick timing and message counts for the admin Live view. Recording runs every tick for every room,
 * so it only writes numbers into preallocated typed arrays; arrays are only made when the admin API
 * reads them, every few seconds at most.
 */

/** A fixed-size ring of the last `capacity` samples. */
export class Ring {
  private readonly buf: Float64Array;
  private head = 0;
  private filled = 0;

  constructor(readonly capacity: number) {
    this.buf = new Float64Array(capacity);
  }

  push(v: number): void {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
  }

  get size(): number {
    return this.filled;
  }

  /** The `i`th newest sample, 0 being the latest. */
  private back(i: number): number {
    return this.buf[(this.head - 1 - i + this.capacity * 2) % this.capacity] ?? 0;
  }

  /** Mean of the newest `n` samples (all by default); 0 when empty. */
  mean(n = this.filled): number {
    const k = Math.min(n, this.filled);
    if (k === 0) return 0;
    let sum = 0;
    for (let i = 0; i < k; i++) sum += this.back(i);
    return sum / k;
  }

  max(n = this.filled): number {
    const k = Math.min(n, this.filled);
    let m = 0;
    for (let i = 0; i < k; i++) m = Math.max(m, this.back(i));
    return m;
  }

  /** Oldest first. */
  values(): number[] {
    const out: number[] = new Array<number>(this.filled);
    for (let i = 0; i < this.filled; i++) out[i] = this.back(this.filled - 1 - i);
    return out;
  }
}

/** Five seconds of ticks per room: long enough to smooth a GC pause, short enough to show a spike. */
export const ROOM_TICK_SAMPLES = 5 * SIM.tickRate;

/** The last 10 one-second buckets are what "now" means for the server's tick and message rates. */
const RECENT_SECONDS = 10;

/** Two decimals is finer than a timer tick of `performance.now()` and keeps the JSON short. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The whole server's tick and traffic, rolled up into one bucket per second of ticks (SIM.tickRate
 * ticks), so the sparkline covers minutes in a few hundred numbers.
 */
export class ServerStats {
  private readonly mean = new Ring(TICK_HISTORY_SECONDS);
  private readonly worst = new Ring(TICK_HISTORY_SECONDS);
  private readonly inPerSec = new Ring(RECENT_SECONDS);
  private readonly outPerSec = new Ring(RECENT_SECONDS);
  private sum = 0;
  private peak = 0;
  private ticks = 0;
  /** Counted as they happen; the bucket takes the difference since the last one. */
  messagesIn = 0;
  messagesOut = 0;
  private lastIn = 0;
  private lastOut = 0;

  constructor(private readonly ticksPerBucket: number = SIM.tickRate) {}

  recordTick(ms: number): void {
    this.sum += ms;
    if (ms > this.peak) this.peak = ms;
    if (++this.ticks < this.ticksPerBucket) return;
    this.mean.push(this.sum / this.ticks);
    this.worst.push(this.peak);
    this.inPerSec.push(this.messagesIn - this.lastIn);
    this.outPerSec.push(this.messagesOut - this.lastOut);
    this.lastIn = this.messagesIn;
    this.lastOut = this.messagesOut;
    this.sum = 0;
    this.peak = 0;
    this.ticks = 0;
  }

  snapshot(): { tickMs: number; tickMaxMs: number; tickHistory: { mean: number[]; max: number[] }; messagesIn: number; messagesOut: number } {
    return {
      tickMs: round2(this.mean.mean(RECENT_SECONDS)),
      tickMaxMs: round2(this.worst.max(RECENT_SECONDS)),
      tickHistory: { mean: this.mean.values().map(round2), max: this.worst.values().map(round2) },
      messagesIn: Math.round(this.inPerSec.mean()),
      messagesOut: Math.round(this.outPerSec.mean()),
    };
  }
}

export function roomTiming(ring: Ring): { tickMs: number; tickMaxMs: number } {
  return { tickMs: round2(ring.mean()), tickMaxMs: round2(ring.max()) };
}

/** One per process, like the event log: Client.send counts into it without a reference to the manager. */
export const serverStats = new ServerStats();
