import { ARENA } from '../config/sim.js';
import type { EnemyTypeId } from '../data/enemies.js';
import { BIOMES, bossFor, monsterPool } from '../data/monsterPools.js';
import type { EnemyComp } from './ecs.js';
import { enemySpawnPoint, spawnEnemy } from './enemies.js';
import { monsterXp } from './progression.js';
import type { Simulation } from './simulation.js';

/** Scoring state of an Arena run. Its presence on a simulation is what makes the room an Arena run. */
export interface ArenaState {
  /** Average character level of the party when the run started; wave 1 monsters are this level. */
  partyLevel: number;
  score: number;
  kills: number;
  /** Highest wave whose monsters have all died. */
  cleared: number;
}

/** What one wave brings. Pure, so the scaling can be tested and tuned without running a fight. */
export interface ArenaWave {
  count: number;
  rareChance: number;
  packChance: number;
  level: number;
  boss: boolean;
}

export function arenaWave(wave: number, livingPlayers: number, partyLevel: number): ArenaWave {
  const n = Math.max(1, wave);
  const base = Math.min(ARENA.maxCount, ARENA.baseCount + ARENA.perWave * (n - 1));
  return {
    count: Math.floor(base * (1 + ARENA.perExtraPlayer * (Math.max(1, livingPlayers) - 1))),
    rareChance: Math.min(ARENA.rareChanceMax, ARENA.rareChanceBase + ARENA.rareChancePerWave * (n - 1)),
    packChance: Math.min(ARENA.packChanceMax, ARENA.packChancePerWave * (n - 1)),
    level: Math.max(1, partyLevel) + Math.floor((n - 1) * ARENA.levelPerWave),
    boss: n % ARENA.bossEvery === 0,
  };
}

/**
 * Points for a kill: the monster's XP value before the level-gap penalty, so outlevelling the
 * waves does not cut the score. Monsters that pay no rewards (raised corpses) score nothing, or a
 * necromancer's adds would be an endless source of points.
 */
export function killScore(e: Pick<EnemyComp, 'level' | 'rare' | 'boss' | 'summonerId' | 'rewards'>): number {
  return e.rewards ? Math.round(monsterXp(e)) : 0;
}

export function waveClearBonus(wave: number): number {
  return wave * ARENA.waveClearBonus;
}

/** The party's average level, rounded, for the first wave's monster level. */
export function partyLevel(levels: readonly number[]): number {
  if (levels.length === 0) return 1;
  return Math.max(1, Math.round(levels.reduce((s, l) => s + l, 0) / levels.length));
}

/** Turns a fresh simulation into an Arena run. The first wave comes after a short delay. */
export function startArena(sim: Simulation, level: number): void {
  sim.arena = { partyLevel: Math.max(1, level), score: 0, kills: 0, cleared: 0 };
  sim.wave = 0;
  sim.waveTimer = ARENA.firstWaveDelaySeconds;
}

export function scoreKill(sim: Simulation, e: EnemyComp): void {
  if (!sim.arena) return;
  const points = killScore(e);
  if (points <= 0) return;
  sim.arena.score += points;
  sim.arena.kills++;
}

/** Everyone inside is down, or nobody is left: the run is over. */
export function arenaOver(sim: Simulation): boolean {
  for (const p of sim.world.player.values()) if (p.respawnIn === null) return false;
  return true;
}

function livingPlayers(sim: Simulation): number[] {
  const out: number[] = [];
  for (const [id, p] of sim.world.player) if (p.respawnIn === null) out.push(id);
  return out;
}

/** Arena waves: a wave spawns when the last one is dead and the breather has run out. */
export function updateArenaWaves(sim: Simulation, dt: number): void {
  const arena = sim.arena;
  if (!arena) return;
  const players = livingPlayers(sim);
  if (players.length === 0) return;
  for (const id of sim.world.enemy.keys()) {
    if (sim.world.isAlive(id)) {
      sim.waveTimer = Math.max(sim.waveTimer, ARENA.breatherSeconds);
      return;
    }
  }
  if (sim.wave > arena.cleared) {
    arena.cleared = sim.wave;
    arena.score += waveClearBonus(sim.wave);
    sim.waveTimer = ARENA.breatherSeconds;
  }
  sim.waveTimer -= dt;
  if (sim.waveTimer > 0) return;

  sim.wave++;
  const spec = arenaWave(sim.wave, players.length, arena.partyLevel);
  // The pit cycles through the biomes, so every monster family turns up over a long run.
  const biome = BIOMES[(sim.wave - 1) % BIOMES.length] ?? 'meadow';
  const pool = monsterPool(biome, spec.level);
  const types: EnemyTypeId[] = ['chaser', 'chaser', ...(sim.wave >= 2 ? (['shooter'] as const) : []), ...pool];
  const pick = (): EnemyTypeId => types[sim.rand.world.int(0, types.length - 1)] ?? 'chaser';
  let spawned = 0;
  while (spawned < spec.count) {
    const at = enemySpawnPoint(sim, players);
    if (sim.rand.world.next() < spec.packChance) {
      const size = Math.min(spec.count - spawned, sim.rand.world.int(ARENA.packSize.min, ARENA.packSize.max));
      const kind = pool[sim.rand.world.int(0, pool.length - 1)] ?? 'chaser';
      for (let i = 0; i < size; i++) {
        const a = (Math.PI * 2 * i) / size;
        // The first of a pack leads it as a rare, like a champion pack in the Wilds.
        spawnEnemy(sim, kind, at.x + Math.cos(a) * 40, at.y + Math.sin(a) * 40, { rare: i === 0, level: spec.level, aggro: true });
      }
      spawned += size;
    } else {
      spawnEnemy(sim, pick(), at.x, at.y, { rare: sim.rand.world.next() < spec.rareChance, level: spec.level, aggro: true });
      spawned++;
    }
  }
  if (spec.boss) {
    const at = enemySpawnPoint(sim, players);
    spawnEnemy(sim, bossFor(biome, spec.level), at.x, at.y, { rare: true, level: spec.level, aggro: true, boss: true });
  }
}
