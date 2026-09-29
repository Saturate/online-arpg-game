import { DUNGEON, partyLevel, SIM, type DungeonRef, type StagingMessage } from '@rune/shared';
import type { Client } from './client.js';
import type { Room } from './room.js';

/** What the antechamber leads to: one dungeon, or the Arena. */
export type StagingTarget = { kind: 'dungeon'; ref: DungeonRef } | { kind: 'arena' };

/**
 * Ready check for one antechamber. When everyone inside is ready a short countdown runs, then the
 * manager sends the whole party into a fresh run together. While a dungeon run is live, its gate
 * lets latecomers straight in, like joining a party's side area in PoE. Arena runs are scored, so
 * they never take latecomers; the gate stays free for the next party instead.
 */
export class Staging {
  readonly ready = new Set<string>();
  /** Ticks left on the countdown, or null when not everyone is ready. */
  countdown: number | null = null;
  /** Room id of the live dungeon run, if any. The manager clears it when that room closes. */
  runRoomId: string | null = null;
  runs = 0;
  /** The current or last run was cleared; reset when a new run starts. */
  cleared = false;
  private lastSentKey = '';

  constructor(
    readonly room: Room,
    readonly target: StagingTarget,
  ) {}

  setReady(client: Client, ready: boolean): void {
    if (!this.room.members.has(client.id)) return;
    if (ready) this.ready.add(client.id);
    else this.ready.delete(client.id);
    this.recheck();
  }

  /** Call after anyone arrives or leaves: a newcomer who is not ready stops the countdown. */
  recheck(): void {
    for (const id of this.ready) if (!this.room.members.has(id)) this.ready.delete(id);
    const all = this.room.members.size > 0 && [...this.room.members.keys()].every((id) => this.ready.has(id));
    if (!all) this.countdown = null;
    else this.countdown ??= DUNGEON.countdownSeconds * SIM.tickRate;
  }

  /** Advances the countdown. Returns true on the tick the party should be sent in. */
  tick(): boolean {
    if (this.countdown === null) return false;
    this.countdown--;
    if (this.countdown > 0) return false;
    this.countdown = null;
    this.ready.clear();
    return true;
  }

  /** Character levels of everyone inside, for the Arena's starting monster level. */
  levels(): number[] {
    return [...this.room.members.values()].map((m) => this.room.sim.world.player.get(m.playerId)?.level ?? 1);
  }

  message(inside: number): StagingMessage {
    const members = [...this.room.members.values()].map((m) => {
      const p = this.room.sim.world.player.get(m.playerId);
      return { name: p?.name ?? '?', cls: p?.classId ?? 'warrior', ready: this.ready.has(m.client.id) };
    });
    return {
      t: 'staging',
      kind: this.target.kind,
      members,
      countdown: this.countdown === null ? null : Math.ceil(this.countdown / SIM.tickRate),
      open: this.runRoomId !== null,
      inside,
      level: this.target.kind === 'dungeon' ? this.target.ref.level : partyLevel(this.levels()),
      cleared: this.cleared,
    };
  }

  /** Sends only when something visible changed, so a countdown costs one message per second. */
  broadcast(inside: number, force = false): void {
    const msg = this.message(inside);
    const key = JSON.stringify(msg);
    if (!force && key === this.lastSentKey) return;
    this.lastSentKey = key;
    for (const m of this.room.members.values()) m.client.send(msg);
  }
}
