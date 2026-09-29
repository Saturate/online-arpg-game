import { arenaOver, can, SIM, type ArenaStatus, type ClassId } from '@rune/shared';
import type { Room } from './room.js';

/**
 * One Arena run: a fresh room for the party that was in the gate at the countdown. It keeps who
 * started (the leaderboard row names them even if they leave early) and runs the score screen at
 * the end before the manager sends everyone back to the gate.
 */
export class ArenaRun {
  readonly startTick: number;
  readonly party: { name: string; cls: ClassId }[];
  /** A builder or above was in the party at the start; see LeaderboardEntry.staff. */
  readonly staff: boolean;
  /** Ticks left on the score screen; null while the run is live. */
  returnIn: number | null = null;
  private lastSentKey = '';

  constructor(
    readonly room: Room,
    /** Room id of the Arena gate the run started from, and goes back to. */
    readonly gateId: string,
  ) {
    this.startTick = room.sim.tick;
    this.party = [...room.members.values()].flatMap((m) => {
      const p = room.sim.world.player.get(m.playerId);
      return p ? [{ name: p.name, cls: p.classId }] : [];
    });
    this.staff = [...room.members.values()].some((m) => can(m.client.role, 'devTools'));
  }

  get finished(): boolean {
    return this.returnIn !== null;
  }

  /** Everyone inside is down, or everyone has left. */
  get over(): boolean {
    return arenaOver(this.room.sim);
  }

  get seconds(): number {
    return Math.round((this.room.sim.tick - this.startTick) / SIM.tickRate);
  }

  status(): ArenaStatus {
    const sim = this.room.sim;
    let alive = 0;
    for (const p of sim.world.player.values()) if (p.respawnIn === null) alive++;
    let monsters = false;
    for (const id of sim.world.enemy.keys()) if (sim.world.isAlive(id)) monsters = true;
    return {
      t: 'arena',
      wave: sim.wave,
      score: sim.arena?.score ?? 0,
      alive,
      inside: sim.world.player.size,
      nextWaveIn: monsters ? null : Math.max(0, Math.ceil(sim.waveTimer)),
    };
  }

  /** Sends only when something visible changed, like the antechamber's ready list. */
  broadcast(force = false): void {
    const msg = this.status();
    const key = JSON.stringify(msg);
    if (!force && key === this.lastSentKey) return;
    this.lastSentKey = key;
    for (const m of this.room.members.values()) m.client.send(msg);
  }
}
