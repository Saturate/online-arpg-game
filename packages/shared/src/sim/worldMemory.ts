import { markChestsOpened, openedChests } from './chests.js';
import { gateTimers, restoreGateTimers, type GateTimer } from './gates.js';
import type { Simulation } from './simulation.js';
import { bossesDown, markBossesDown } from './streaming.js';

/**
 * What a world copy keeps when its room closes or is rebuilt round a new town: dead gate bosses'
 * timers, the chunks whose region boss is dead and the opened chests. Without it a room that closed
 * after standing empty for a few minutes reopened with every boss and chest back, well before the
 * boss timer and the chest refills (owner decision, 2026-10-01). The server holds it in memory per
 * world copy, so a restart still starts fresh. Monsters other than bosses are not kept: they come
 * back fresh, as a refill would bring them.
 */
export interface WorldMemory {
  gates: GateTimer[];
  bosses: string[];
  chests: string[];
}

export function rememberWorld(sim: Simulation): WorldMemory {
  return { gates: gateTimers(sim), bosses: bossesDown(sim), chests: [...openedChests(sim)] };
}

/** Into a new room of the same world copy, before anyone is in it. */
export function restoreWorld(sim: Simulation, memory: WorldMemory): void {
  restoreGateTimers(sim, memory.gates);
  markBossesDown(sim, memory.bosses);
  markChestsOpened(sim, memory.chests);
}
