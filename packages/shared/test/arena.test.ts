import { describe, expect, it } from 'vitest';
import { ARENA, arenaOver, arenaWave, killScore, monsterXp, partyLevel, seasonOf, Simulation, startArena, waveClearBonus, SIM } from '../src/index.js';
import { dealDamage } from '../src/sim/combat.js';
import { spawnEnemy } from '../src/sim/enemies.js';

describe('Arena wave scaling', () => {
  it('grows every wave: more monsters, more rares and packs, higher level, never easier', () => {
    let prev = arenaWave(1, 1, 7);
    expect(prev).toMatchObject({ count: ARENA.baseCount, level: 7, packChance: 0, boss: false });
    for (let wave = 2; wave <= 40; wave++) {
      const w = arenaWave(wave, 1, 7);
      expect(w.count).toBeGreaterThanOrEqual(prev.count);
      expect(w.rareChance).toBeGreaterThanOrEqual(prev.rareChance);
      expect(w.packChance).toBeGreaterThanOrEqual(prev.packChance);
      expect(w.level).toBeGreaterThanOrEqual(prev.level);
      expect(w.rareChance).toBeLessThanOrEqual(ARENA.rareChanceMax);
      expect(w.boss).toBe(wave % ARENA.bossEvery === 0);
      prev = w;
    }
    expect(arenaWave(11, 1, 7).level).toBe(7 + 5);
    expect(arenaWave(40, 1, 1).count).toBe(ARENA.maxCount);
  });

  it('sends more monsters for more living players, and starts at the party average level', () => {
    expect(arenaWave(3, 3, 1).count).toBeGreaterThan(arenaWave(3, 1, 1).count);
    expect(partyLevel([4, 5, 9])).toBe(6);
    expect(partyLevel([])).toBe(1);
  });
});

describe('Arena scoring', () => {
  it('scores a kill at its XP value before the level-gap penalty, and nothing for rewardless monsters', () => {
    const e = { level: 12, rare: true, boss: false, summonerId: null, rewards: true };
    expect(killScore(e)).toBe(Math.round(monsterXp(e)));
    expect(killScore({ ...e, rewards: false })).toBe(0);
    expect(waveClearBonus(3)).toBe(3 * ARENA.waveClearBonus);
  });

  it('names seasons by UTC month', () => {
    expect(seasonOf(Date.UTC(2026, 8, 30, 23, 59))).toBe('2026-09');
    expect(seasonOf(Date.UTC(2026, 9, 1, 0, 0))).toBe('2026-10');
  });

  it('runs a simulation as an Arena run: first wave after the delay, no loot, half XP, one life', () => {
    const arena = new Simulation(3, { kind: 'arena' });
    startArena(arena, 1);
    const pid = arena.addPlayer('c', 'warrior');
    for (let i = 0; i < (ARENA.firstWaveDelaySeconds - 0.5) * SIM.tickRate; i++) arena.step();
    expect(arena.wave).toBe(0);
    for (let i = 0; i < SIM.tickRate && arena.wave === 0; i++) arena.step();
    expect(arena.wave).toBe(1);

    const normal = new Simulation(3, { kind: 'arena' });
    const other = normal.addPlayer('c', 'warrior');
    const a = spawnEnemy(arena, 'chaser', 900, 900, { rare: false, level: 1, aggro: false });
    const b = spawnEnemy(normal, 'chaser', 900, 900, { rare: false, level: 1, aggro: false });
    const before = arena.world.player.get(pid)?.xp ?? 0;
    dealDamage(arena, a, 1e9, pid, []);
    dealDamage(normal, b, 1e9, other, []);
    const gained = (arena.world.player.get(pid)?.xp ?? 0) - before;
    expect(gained).toBeCloseTo((normal.world.player.get(other)?.xp ?? 0) * ARENA.xpMultiplier, 6);
    arena.step();
    expect(arena.world.loot.size).toBe(0);

    expect(arenaOver(arena)).toBe(false);
    dealDamage(arena, pid, 1e9, pid, []);
    for (let i = 0; i < (SIM.playerRespawnSeconds + 2) * SIM.tickRate; i++) arena.step();
    expect(arena.world.player.get(pid)?.respawnIn).not.toBeNull();
    expect(arenaOver(arena)).toBe(true);
  });

  it('still respawns outside Arena runs', () => {
    const sim = new Simulation(3, { kind: 'arena' });
    const pid = sim.addPlayer('c', 'warrior');
    dealDamage(sim, pid, 1e9, pid, []);
    for (let i = 0; i < (SIM.playerRespawnSeconds + 1) * SIM.tickRate; i++) sim.step();
    expect(sim.world.player.get(pid)?.respawnIn).toBeNull();
  });
});

describe('Arena wave time limit', () => {
  it('sends the next wave when one drags past the limit, without the clear bonus', () => {
    const sim = new Simulation(3, { kind: 'arena' });
    sim.addPlayer('p', 'warrior');
    startArena(sim, 1);
    const p = [...sim.world.player.values()][0];
    if (p) p.god = true;
    let guard = 0;
    while (sim.wave < 1 && guard++ < 10 * SIM.tickRate) sim.step();
    expect(sim.wave).toBe(1);
    // Nobody fights: the wave stays alive until the limit, then wave 2 joins it.
    for (let i = 0; i < (ARENA.waveTimeLimitSeconds + 1) * SIM.tickRate; i++) sim.step();
    expect(sim.wave).toBe(2);
    expect(sim.arena?.cleared).toBe(0);
    expect(sim.arena?.score).toBe(0);
  });
});
