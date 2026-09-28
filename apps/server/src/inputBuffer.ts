import { SIM, type InputFrame } from '@rune/shared';

/**
 * Each input represents one tick of movement. A player earns one credit per server tick and spends
 * one per applied input, so bursts after jitter are absorbed but the long-run rate can never
 * exceed the tick rate.
 */
export class InputBuffer {
  private queue: InputFrame[] = [];
  private credits = 0;
  private lastQueuedSeq = -1;

  push(input: InputFrame): void {
    if (input.seq <= this.lastQueuedSeq) return;
    this.lastQueuedSeq = input.seq;
    this.queue.push(input);
    if (this.queue.length > SIM.inputQueueMax) this.queue.shift();
  }

  /** Call once per tick. Returns the inputs to apply this tick, in order. */
  drain(): InputFrame[] {
    this.credits = Math.min(SIM.inputCreditCap, this.credits + 1);
    const n = Math.min(this.credits, this.queue.length);
    this.credits -= n;
    return this.queue.splice(0, n);
  }

  get size(): number {
    return this.queue.length;
  }
}
