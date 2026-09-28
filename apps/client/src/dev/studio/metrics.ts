import { SIM } from '@rune/shared';

/** What happened in one simulation tick, as far as the studio cares. */
export interface TickSample {
  tick: number;
  casts: number;
  hits: number;
  damage: number;
  explodes: number;
  fizzles: number;
  heatSpent: number;
  /** Spell entities owned by the player alive after the tick; shows splits and pulses as a curve. */
  live: number;
}

export interface MetricsSummary {
  seconds: number;
  damage: number;
  hits: number;
  casts: number;
  fizzles: number;
  dpsWindow: number;
  dpsRun: number;
  hitsPerCast: number;
  heatPerSecond: number;
  peakLive: number;
}

/** Ticks kept for the timeline strip: 15 seconds at 20 Hz. */
export const TIMELINE_TICKS = 300;

export class StudioMetrics {
  private samples: TickSample[] = [];
  private ticks = 0;
  private damage = 0;
  private hits = 0;
  private casts = 0;
  private fizzles = 0;
  private heat = 0;
  private peakLive = 0;

  constructor(private readonly windowSeconds = 5) {}

  push(s: TickSample): void {
    this.samples.push(s);
    if (this.samples.length > TIMELINE_TICKS) this.samples.shift();
    this.ticks++;
    this.damage += s.damage;
    this.hits += s.hits;
    this.casts += s.casts;
    this.fizzles += s.fizzles;
    this.heat += s.heatSpent;
    this.peakLive = Math.max(this.peakLive, s.live);
  }

  reset(): void {
    this.samples = [];
    this.ticks = 0;
    this.damage = 0;
    this.hits = 0;
    this.casts = 0;
    this.fizzles = 0;
    this.heat = 0;
    this.peakLive = 0;
  }

  get timeline(): readonly TickSample[] {
    return this.samples;
  }

  summary(): MetricsSummary {
    const seconds = this.ticks * SIM.dt;
    const windowTicks = Math.round(this.windowSeconds / SIM.dt);
    const recent = this.samples.slice(-windowTicks);
    const recentDamage = recent.reduce((sum, s) => sum + s.damage, 0);
    // Early in a run the window is not full yet; dividing by the full window would understate DPS.
    const windowSeconds = recent.length * SIM.dt;
    return {
      seconds,
      damage: this.damage,
      hits: this.hits,
      casts: this.casts,
      fizzles: this.fizzles,
      dpsWindow: windowSeconds > 0 ? recentDamage / windowSeconds : 0,
      dpsRun: seconds > 0 ? this.damage / seconds : 0,
      hitsPerCast: this.casts > 0 ? this.hits / this.casts : 0,
      heatPerSecond: seconds > 0 ? this.heat / seconds : 0,
      peakLive: this.peakLive,
    };
  }
}
