import { NAV } from '../config/sim.js';
import { updateArenaWaves } from './arena.js';
import { updateChests } from './chests.js';
import { updateAuras } from './auras.js';
import { isTargetable } from './combat.js';
import { updateStatuses } from './combat.js';
import { updateEnemies, updateWaves } from './enemies.js';
import { updateLoot } from './inventory.js';
import { updateMinionRespawns, updateMinions } from './minions.js';
import { updatePlayers } from './players.js';
import type { Simulation } from './simulation.js';
import { updateNovas, updateProjectiles, updateZones } from './spells.js';
import { updateStreaming } from './streaming.js';

export interface System {
  name: string;
  run(sim: Simulation, dt: number): void;
}

/**
 * Every system that runs once per tick, in order. Input (movement, casting, dash hits) is applied
 * before this pipeline by `Simulation.applyInput`.
 *
 * Order matters: auras recompute buffs before anything deals damage this tick, AI moves before
 * projectiles resolve so hits use this tick's positions, and waves run last so a fresh wave
 * is not simulated before clients have seen it.
 */
/** Enemies path toward living players and minions; the field only changes as they move, so a few ticks stale is fine. */
function updateNav(sim: Simulation): void {
  if (sim.tick % NAV.rebuildEveryTicks !== 0) return;
  const w = sim.world;
  const targets = [];
  for (const id of [...w.player.keys(), ...w.minion.keys()]) {
    const p = w.position.get(id);
    if (p && isTargetable(sim, id)) targets.push(p);
  }
  sim.nav.rebuild(targets);
}

export const SYSTEMS: readonly System[] = [
  { name: 'nav', run: updateNav },
  { name: 'players', run: updatePlayers },
  { name: 'chests', run: updateChests },
  // After players, so a respawn has moved its player to the spawn before sleep is decided; still
  // before anything a sleeper would run.
  { name: 'streaming', run: updateStreaming },
  { name: 'auras', run: updateAuras },
  { name: 'statuses', run: updateStatuses },
  { name: 'enemies', run: updateEnemies },
  { name: 'minions', run: updateMinions },
  { name: 'minionRespawns', run: updateMinionRespawns },
  { name: 'projectiles', run: updateProjectiles },
  { name: 'novas', run: updateNovas },
  { name: 'zones', run: updateZones },
  { name: 'loot', run: updateLoot },
  { name: 'waves', run: (sim, dt) => (sim.arena ? updateArenaWaves(sim, dt) : updateWaves(sim, dt)) },
];
