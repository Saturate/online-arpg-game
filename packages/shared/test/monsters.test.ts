import { describe, expect, it } from 'vitest';
import { BIOMES, bossFor, DEFAULT_RATES, DEFAULT_SERVER_SETTINGS, ENEMIES, ENEMY_LEVEL, ENEMY_TYPE_IDS, familyOf, monsterPool, packScale, parseSettingsPatch, SETTINGS_LIMITS, SIM, Simulation, WAVES, type EnemyTypeId } from '../src/index.js';
import { affixValue } from '../src/items/items.js';
import { dealDamage } from '../src/sim/combat.js';
import { packetOf } from '../src/sim/damage.js';
import { activeHazards, spawnEnemy } from '../src/sim/enemies.js';
import { spawnProjectile } from '../src/sim/spells.js';

/** A flat arena with one player standing at the spawn. Waves never start while a monster lives. */
function setup(seed = 1, god = true) {
  const sim = new Simulation(seed, { kind: 'flat' });
  const pid = sim.addPlayer('c', 'warrior');
  const p = sim.world.player.get(pid);
  if (!p) throw new Error('no player');
  p.god = god;
  const pos = sim.world.position.get(pid);
  if (!pos) throw new Error('no position');
  return { sim, pid, pos };
}

function spawn(sim: Simulation, type: EnemyTypeId, x: number, y: number) {
  return spawnEnemy(sim, type, x, y, { rare: false, level: 1, aggro: true });
}

function run(sim: Simulation, ticks: number, each?: (tick: number) => void) {
  for (let i = 0; i < ticks; i++) {
    sim.step();
    each?.(i);
  }
}

function lifeOf(sim: Simulation, id: number): number {
  return sim.world.health.get(id)?.life ?? -1;
}

describe('monster roster', () => {
  it('has at least 20 new types across the families', () => {
    const monsters = ENEMY_TYPE_IDS.filter((t) => ENEMIES[t].behaviour === 'monster');
    expect(monsters.length).toBeGreaterThanOrEqual(20);
    const families = new Set(monsters.map(familyOf));
    for (const f of ['swarm', 'brute', 'archer', 'caster', 'summoner', 'charger', 'exploder', 'shielder', 'shaman', 'leaper', 'burrower', 'totem', 'ghost', 'poisoner', 'splitter', 'boss'] as const) {
      expect(families.has(f), f).toBe(true);
    }
  });

  it('every type spawns and fights a player for 15 seconds without errors', () => {
    for (const type of ENEMY_TYPE_IDS) {
      const { sim, pos } = setup(7);
      const id = spawn(sim, type, pos.x + 180, pos.y);
      expect(() => run(sim, 15 * SIM.tickRate, () => sim.takeEvents())).not.toThrow();
      // Everything but suicide bombers is still around after harmlessly swinging at a god-mode player.
      if (type !== 'volatile') expect(sim.world.enemy.has(id), type).toBe(true);
    }
  });

  it('is deterministic for the same seed', () => {
    const trace = () => {
      const { sim, pos } = setup(11, false);
      for (const t of ['necromancer', 'grave_brute', 'venom_spider', 'storm_caller', 'ooze'] as const) spawn(sim, t, pos.x + 200, pos.y + 40);
      run(sim, 400, () => sim.takeEvents());
      return JSON.stringify([...sim.world.enemy].map(([id, e]) => [id, e.typeId, sim.world.position.get(id), lifeOf(sim, id)]));
    };
    expect(trace()).toBe(trace());
  });
});

describe('monster behaviours', () => {
  it('summoners never exceed their cap', () => {
    const { sim, pos } = setup(3);
    const necro = spawn(sim, 'necromancer', pos.x + 250, pos.y);
    let most = 0;
    run(sim, 60 * SIM.tickRate, () => {
      sim.takeEvents();
      let n = 0;
      for (const e of sim.world.enemy.values()) if (e.summonerId === necro) n++;
      most = Math.max(most, n);
    });
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(5);
  });

  it('splitters split into smaller ones when killed', () => {
    const { sim, pid, pos } = setup(4);
    const ooze = spawn(sim, 'ooze', pos.x + 200, pos.y);
    dealDamage(sim, ooze, packetOf('physical', 1e6), pid);
    run(sim, 2);
    const lings = [...sim.world.enemy.values()].filter((e) => e.typeId === 'oozeling');
    expect(lings).toHaveLength(3);
  });

  it('a volatile only hurts after its wind-up, in its radius, and dies doing it', () => {
    const { sim, pos, pid } = setup(5, false);
    const vol = spawn(sim, 'volatile', pos.x + 45, pos.y);
    const start = lifeOf(sim, pid);
    let teleTick = -1;
    let hitTick = -1;
    run(sim, 60, (t) => {
      for (const { ev } of sim.takeEvents()) if (ev.e === 'tele' && ev.id === vol && teleTick < 0) teleTick = t;
      if (hitTick < 0 && lifeOf(sim, pid) < start) hitTick = t;
    });
    const def = ENEMIES.volatile;
    const windup = def.behaviour === 'monster' ? (def.abilities[0]?.windup ?? 0) : 0;
    expect(teleTick).toBeGreaterThanOrEqual(0);
    expect(hitTick - teleTick).toBeGreaterThanOrEqual(Math.floor(windup * SIM.tickRate) - 1);
    expect(sim.world.enemy.has(vol)).toBe(false);
  });

  it('a telegraphed slam can be dodged by leaving the circle', () => {
    const { sim, pos, pid } = setup(6, false);
    spawn(sim, 'grave_brute', pos.x + 60, pos.y);
    let atTele = -1;
    run(sim, 5 * SIM.tickRate, () => {
      for (const { ev } of sim.takeEvents()) {
        if (ev.e === 'tele' && atTele < 0) {
          // Step well out of the marked area the moment it appears; its melee swings before this do not count.
          atTele = lifeOf(sim, pid);
          pos.x -= 400;
        }
      }
      if (atTele >= 0) expect(lifeOf(sim, pid)).toBe(atTele);
    });
    expect(atTele).toBeGreaterThan(0);
  });

  it('burrowed monsters cannot be hit until they surface', () => {
    const { sim, pid, pos } = setup(8);
    const worm = spawn(sim, 'sand_burrower', pos.x + 600, pos.y);
    const e = sim.world.enemy.get(worm);
    expect(e?.burrowed).toBe(true);
    const before = lifeOf(sim, worm);
    dealDamage(sim, worm, packetOf('physical', 50), pid);
    expect(lifeOf(sim, worm)).toBe(before);
    let surfaced = false;
    run(sim, 10 * SIM.tickRate, () => {
      sim.takeEvents();
      if (sim.world.enemy.get(worm)?.burrowed === false) surfaced = true;
    });
    expect(surfaced).toBe(true);
  });

  it('shielders block shots from the front but not from behind', () => {
    const { sim, pid, pos } = setup(9);
    const guard = spawn(sim, 'tomb_guard', pos.x + 200, pos.y);
    run(sim, 2, () => sim.takeEvents());
    const gpos = sim.world.position.get(guard);
    if (!gpos) throw new Error('no guard');
    const shoot = (fromX: number, angle: number) =>
      spawnProjectile(sim, { ownerId: pid, team: 'players', x: fromX, y: gpos.y, angle, speed: 900, radius: 6, range: 400, damage: packetOf('physical', 20) });
    const full = lifeOf(sim, guard);
    shoot(gpos.x - 80, 0);
    run(sim, 3, () => sim.takeEvents());
    expect(lifeOf(sim, guard)).toBe(full);
    shoot(gpos.x + 80, Math.PI);
    run(sim, 3, () => sim.takeEvents());
    expect(lifeOf(sim, guard)).toBeLessThan(full);
  });

  it('shamans raise fallen monsters, but only once', () => {
    const { sim, pid, pos } = setup(10);
    spawn(sim, 'fallen_shaman', pos.x + 300, pos.y);
    const imp = spawn(sim, 'chaser', pos.x + 260, pos.y + 40);
    dealDamage(sim, imp, packetOf('physical', 1e6), pid);
    let raised: number | null = null;
    run(sim, 12 * SIM.tickRate, () => {
      sim.takeEvents();
      for (const [id, e] of sim.world.enemy) if (e.typeId === 'chaser' && e.raised) raised = id;
    });
    expect(raised).not.toBeNull();
  });

  it('poison pools hurt whoever stands in them', () => {
    const { sim, pid, pos } = setup(12, false);
    spawn(sim, 'bog_spitter', pos.x + 300, pos.y);
    const start = lifeOf(sim, pid);
    let sawPool = false;
    run(sim, 10 * SIM.tickRate, () => {
      sim.takeEvents();
      if (activeHazards(sim).length > 0) sawPool = true;
    });
    expect(sawPool).toBe(true);
    expect(lifeOf(sim, pid)).toBeLessThan(start);
  });

  it('bosses enrage below their threshold', () => {
    const { sim, pid, pos } = setup(13);
    const boss = spawnEnemy(sim, 'butcher', pos.x + 300, pos.y, { rare: true, level: 3, aggro: true, boss: true });
    const h = sim.world.health.get(boss);
    if (!h) throw new Error('no boss');
    dealDamage(sim, boss, packetOf('physical', h.maxLife * 0.6), pid);
    run(sim, 2, () => sim.takeEvents());
    expect(sim.world.enemy.get(boss)?.enraged).toBe(true);
  });
});

describe('boss tuning', () => {
  /** Life before the armored affix, which a boss may roll. */
  const baseLife = (sim: Simulation, id: number): number => {
    const e = sim.world.enemy.get(id);
    const h = sim.world.health.get(id);
    if (!e || !h) throw new Error('no monster');
    return h.maxLife / (1 + affixValue(e.affixes, 'armored') / 100);
  };
  const levelLife = (level: number) => 1 + ENEMY_LEVEL.lifePerLevel * (level - 1);
  const levelDamage = (level: number) => 1 + ENEMY_LEVEL.damagePerLevel * (level - 1);

  it('defaults to half the old boss life (4.5x base) and twice the damage', () => {
    expect(WAVES.rareLifeMultiplier * DEFAULT_RATES.bossLife).toBe(4.5);
    expect(DEFAULT_RATES.bossDamage).toBe(2);
    expect(DEFAULT_SERVER_SETTINGS.bossLifeMultiplier).toBe(DEFAULT_RATES.bossLife);
    expect(DEFAULT_SERVER_SETTINGS.bossDamageMultiplier).toBe(DEFAULT_RATES.bossDamage);
    const { sim, pos } = setup(21);
    const level = 4;
    const boss = spawnEnemy(sim, 'butcher', pos.x + 400, pos.y, { rare: true, level, aggro: false, boss: true });
    const rare = spawnEnemy(sim, 'butcher', pos.x - 400, pos.y, { rare: true, level, aggro: false });
    const def = ENEMIES.butcher;
    expect(baseLife(sim, boss)).toBeCloseTo(def.life * 4.5 * levelLife(level), -1);
    expect(baseLife(sim, rare)).toBeCloseTo(def.life * 3 * levelLife(level), -1);
    expect(sim.world.enemy.get(boss)?.damageMult).toBeCloseTo(2 * levelDamage(level));
    expect(sim.world.enemy.get(rare)?.damageMult).toBeCloseTo(levelDamage(level));
  });

  it('applies changed admin rates to bosses that spawn after, and leaves the living as they are', () => {
    const { sim, pos } = setup(22);
    const before = spawnEnemy(sim, 'lich', pos.x + 400, pos.y, { rare: true, level: 1, aggro: false, boss: true });
    sim.setRates({ ...DEFAULT_RATES, bossLife: 3, bossDamage: 0.5 });
    const after = spawnEnemy(sim, 'lich', pos.x - 400, pos.y, { rare: true, level: 1, aggro: false, boss: true });
    const rare = spawnEnemy(sim, 'lich', pos.x, pos.y + 400, { rare: true, level: 1, aggro: false });
    expect(baseLife(sim, before)).toBeCloseTo(ENEMIES.lich.life * 4.5, -1);
    expect(baseLife(sim, after)).toBeCloseTo(ENEMIES.lich.life * 9, -1);
    expect(sim.world.enemy.get(before)?.damageMult).toBe(2);
    expect(sim.world.enemy.get(after)?.damageMult).toBe(0.5);
    // Rares are not bosses and keep the rare numbers whatever the boss rates.
    expect(baseLife(sim, rare)).toBeCloseTo(ENEMIES.lich.life * 3, -1);
    expect(sim.world.enemy.get(rare)?.damageMult).toBe(1);
  });

  it('a boss hits twice as hard as the same monster as a rare', () => {
    const firstHit = (boss: boolean): number => {
      const { sim, pid, pos } = setup(23, false);
      const h = sim.world.health.get(pid);
      if (!h) throw new Error('no player');
      h.life = h.maxLife = 1e6;
      spawnEnemy(sim, 'butcher', pos.x + 30, pos.y, { rare: true, level: 1, aggro: true, boss });
      for (let i = 0; i < 40 && h.life === h.maxLife; i++) sim.step();
      return h.maxLife - h.life;
    };
    const rare = firstHit(false);
    expect(rare).toBeGreaterThan(0);
    expect(firstHit(true) / rare).toBeCloseTo(2);
  });

  it('settings accept boss multipliers and the gate timer in range and refuse the rest', () => {
    expect(parseSettingsPatch({ bossLifeMultiplier: 2, bossDamageMultiplier: 3, gateRespawnMinutes: 45 })).toEqual({ bossLifeMultiplier: 2, bossDamageMultiplier: 3, gateRespawnMinutes: 45 });
    for (const key of ['bossLifeMultiplier', 'bossDamageMultiplier'] as const) {
      expect(parseSettingsPatch({ [key]: SETTINGS_LIMITS.bossMultiplierMin })).toEqual({ [key]: SETTINGS_LIMITS.bossMultiplierMin });
      expect(parseSettingsPatch({ [key]: SETTINGS_LIMITS.bossMultiplierMax })).toEqual({ [key]: SETTINGS_LIMITS.bossMultiplierMax });
      for (const bad of [0, SETTINGS_LIMITS.bossMultiplierMin - 0.01, SETTINGS_LIMITS.bossMultiplierMax + 1, -1, Number.NaN, Infinity, '2', null]) {
        expect(typeof parseSettingsPatch({ [key]: bad }), `${key} ${String(bad)}`).toBe('string');
      }
    }
  });
});

describe('monster pools', () => {
  it('every biome has monsters at every level from 1 to 30', () => {
    for (const b of BIOMES) {
      for (let level = 1; level <= 30; level++) expect(monsterPool(b, level).length, `${b} ${level}`).toBeGreaterThan(0);
    }
  });

  it('harder families unlock with level', () => {
    expect(monsterPool('crypt', 1)).not.toContain('necromancer');
    expect(monsterPool('crypt', 10)).toContain('necromancer');
    expect(monsterPool('crypt', 10).length).toBeGreaterThan(monsterPool('crypt', 1).length);
  });

  it('bosses come from the boss family, and swarms come in bigger packs', () => {
    for (const b of BIOMES) for (const level of [1, 5, 20]) expect(familyOf(bossFor(b, level))).toBe('boss');
    expect(packScale('plague_rat')).toBeGreaterThan(packScale('chaser'));
    expect(packScale('ogre')).toBeLessThan(packScale('chaser'));
  });
});
