import type { EntitySnap, Snapshot } from '@rune/shared';

interface Buffered {
  tick: number;
  byId: Map<number, EntitySnap>;
}

const MAX_BUFFERED = 40;

/**
 * Holds recent snapshots and estimates the server clock so other entities can be rendered a fixed
 * delay in the past, always between two known states.
 */
export class InterpolationBuffer {
  private snapshots: Buffered[] = [];
  /** localTime - serverTime, tracked as the minimum observed so network delay spikes do not drag it. */
  private offset: number | null = null;

  constructor(
    private readonly tickMs: number,
    private readonly delayMs: number,
  ) {}

  push(snapshot: Snapshot, receivedAt: number): void {
    const sample = receivedAt - snapshot.tick * this.tickMs;
    // Drift upward slowly so the estimate follows a real increase in latency instead of sticking to one lucky packet.
    if (this.offset === null || sample < this.offset) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.01;

    const byId = new Map<number, EntitySnap>();
    for (const e of snapshot.entities) byId.set(e.id, e);
    this.snapshots.push({ tick: snapshot.tick, byId });
    if (this.snapshots.length > MAX_BUFFERED) this.snapshots.shift();
  }

  /**
   * Returns entities at render time. `t` is the blend factor between the returned `from` and `to`
   * states. Entities absent from `from` render at `to`; entities absent from `to` are gone.
   */
  /** Server tick currently being displayed for interpolated entities. */
  renderTick(now: number): number | null {
    if (this.offset === null) return null;
    return (now - this.offset - this.delayMs) / this.tickMs;
  }

  sample(now: number): { from: Map<number, EntitySnap>; to: Map<number, EntitySnap>; t: number } | null {
    const renderTick = this.renderTick(now);
    if (renderTick === null || this.snapshots.length === 0) return null;

    const first = this.snapshots[0];
    const last = this.snapshots[this.snapshots.length - 1];
    if (!first || !last) return null;
    if (renderTick <= first.tick) return { from: first.byId, to: first.byId, t: 0 };
    if (renderTick >= last.tick) return { from: last.byId, to: last.byId, t: 0 };

    for (let i = this.snapshots.length - 1; i > 0; i--) {
      const a = this.snapshots[i - 1];
      const b = this.snapshots[i];
      if (!a || !b) continue;
      if (a.tick <= renderTick && renderTick < b.tick) {
        return { from: a.byId, to: b.byId, t: (renderTick - a.tick) / (b.tick - a.tick) };
      }
    }
    return { from: last.byId, to: last.byId, t: 0 };
  }
}
