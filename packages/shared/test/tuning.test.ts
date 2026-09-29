import { describe, expect, it } from 'vitest';
import {
  ENEMIES,
  ENEMY_TYPE_IDS,
  MINION_DEFS,
  MINION_TYPE_IDS,
  MonsterTuning,
  enemySource,
  minionSource,
  modelOverridesOf,
  monsterXp,
  parseEnemyOverride,
  parseMinionOverride,
  parseModelOverrides,
  parseTuningOverrides,
  resolveEnemy,
  Simulation,
  type EnemyDef,
  type MinionDef,
  type TuningOverrides,
} from '../src/index.js';

describe('override validation', () => {
  it('accepts known numbers and drops the ones equal to the code', () => {
    expect(parseEnemyOverride('ogre', { life: 400, moveSpeed: 62, abilities: { '1': { cooldown: 5, damage: 26 } } })).toEqual({ life: 400, abilities: { '1': { cooldown: 5 } } });
    expect(parseEnemyOverride('ogre', { xp: 2, model: 'mon_butcher', height: 90 })).toEqual({ xp: 2, model: 'mon_butcher', height: 90 });
    expect(parseMinionOverride('wraith', { damage: 20, kiteDistance: 0 })).toEqual({ damage: 20 });
  });

  it('refuses unknown fields, fields the type does not have, and bad numbers', () => {
    expect(parseEnemyOverride('ogre', { lifee: 400 })).toMatch(/no field "lifee"/);
    // A monster has no bullet stats of its own; those live on its abilities.
    expect(parseEnemyOverride('ogre', { bulletDamage: 4 })).toMatch(/no field/);
    expect(parseEnemyOverride('chaser', { preferredRange: 100 })).toMatch(/no field/);
    expect(parseEnemyOverride('ogre', { life: 0 })).toMatch(/between/);
    expect(parseEnemyOverride('ogre', { life: Number.POSITIVE_INFINITY })).toMatch(/number/);
    expect(parseEnemyOverride('ogre', { life: '300' })).toMatch(/number/);
    expect(parseEnemyOverride('ogre', { abilities: { '2': { cooldown: 1 } } })).toMatch(/no ability 2/);
    expect(parseEnemyOverride('ogre', { abilities: { '0': { bullets: 3 } } })).toMatch(/slam ability has no field "bullets"/);
    expect(parseEnemyOverride('bone_archer', { abilities: { '0': { bullets: 2.5 } } })).toMatch(/whole number/);
    expect(parseEnemyOverride('ogre', { abilities: [] })).toMatch(/object/);
    expect(parseEnemyOverride('ogre', { model: 'hero_mage' })).toMatch(/model/);
    expect(parseEnemyOverride('ogre', { height: 2000 })).toMatch(/between/);
    expect(parseEnemyOverride('ogre', null)).toMatch(/object/);
    expect(parseMinionOverride('zombie_brute', { ranged: true })).toMatch(/no field "ranged"/);
  });

  it('skips stored types that no longer pass instead of dropping everything', () => {
    const warnings: string[] = [];
    const t = parseTuningOverrides({ monsters: { ogre: { life: 500 }, dragon: { life: 1 }, chaser: { life: -1 } }, minions: { wraith: { damage: 30 } } }, (w) => warnings.push(w));
    expect(t).toEqual({ monsters: { ogre: { life: 500 } }, minions: { wraith: { damage: 30 } } });
    expect(warnings).toHaveLength(2);
  });

  it('sends only models and heights to game clients, and checks them on arrival', () => {
    const t: TuningOverrides = { monsters: { ogre: { life: 500, model: 'mon_butcher' }, chaser: { life: 50 } }, minions: { wraith: { height: 60 } } };
    const m = modelOverridesOf(t);
    expect(m).toEqual({ monsters: { ogre: { model: 'mon_butcher' } }, minions: { wraith: { height: 60 } } });
    expect(parseModelOverrides(JSON.parse(JSON.stringify(m)))).toEqual(m);
    expect(parseModelOverrides({ monsters: { ogre: { life: 5 } }, minions: {} })).toMatch(/unknown field/);
    expect(parseModelOverrides({ monsters: { ogre: { model: '../x' } }, minions: {} })).toMatch(/model/);
  });
});

describe('override layer at spawn', () => {
  const tuning = new MonsterTuning({
    monsters: { grave_brute: { life: 999, moveSpeed: 10, radius: 30, contactDamage: 50, xp: 3, abilities: { '0': { damage: 77, cooldown: 9 } } } },
    minions: { zombie_brute: { damage: 99, moveSpeed: 11 }, skeleton_archer: { damage: 99 }, wraith: { damage: 99 } },
  });

  it('spawns new monsters with the overridden numbers', () => {
    const sim = new Simulation(1, { kind: 'flat' }, {}, tuning);
    const id = sim.spawnEnemy('grave_brute', 400, 400);
    const e = sim.world.enemy.get(id);
    expect(sim.world.health.get(id)?.maxLife).toBe(999);
    expect(sim.world.radius.get(id)).toBe(30);
    expect(e?.def.moveSpeed).toBe(10);
    const def = e?.def;
    if (def?.behaviour !== 'monster') throw new Error('grave brute is a monster');
    expect(def.abilities[0]).toMatchObject({ kind: 'slam', damage: 77, cooldown: 9, radius: 70 });
    // The code's own table is never touched.
    expect(ENEMIES.grave_brute.life).toBe(210);
  });

  it('scales kill XP by the multiplier', () => {
    const sim = new Simulation(1, { kind: 'flat' }, {}, tuning);
    const e = sim.world.enemy.get(sim.spawnEnemy('grave_brute', 400, 400));
    if (!e) throw new Error('no enemy');
    expect(monsterXp(e)).toBeCloseTo(monsterXp({ level: 1, rare: false, boss: false }) * 3);
  });

  it('leaves monsters already alive with their numbers when the tuning changes', () => {
    const sim = new Simulation(1);
    const before = sim.spawnEnemy('grave_brute', 400, 400);
    sim.setTuning(tuning);
    const after = sim.spawnEnemy('grave_brute', 500, 400);
    expect(sim.world.health.get(before)?.maxLife).toBe(210);
    expect(sim.world.enemy.get(before)?.def.moveSpeed).toBe(70);
    expect(sim.world.health.get(after)?.maxLife).toBe(999);
    for (let i = 0; i < 5; i++) sim.step();
    expect(sim.world.enemy.get(before)?.def.contactDamage).toBe(12);
  });

  it('spawns minions with the overridden numbers', () => {
    const sim = new Simulation(1, { kind: 'flat' }, {}, tuning);
    const pid = sim.addPlayer('c', 'binder');
    sim.step();
    const p = sim.world.player.get(pid);
    const mid = p?.minions.find((m) => m !== null);
    if (mid === undefined || mid === null) throw new Error('binder has no minion');
    const m = sim.world.minion.get(mid);
    expect(m?.def.damage).toBe(99);
    expect(m?.def.damage).not.toBe(MINION_DEFS[m?.typeId ?? 'wraith'].damage);
  });

  it('shares one resolved definition per type', () => {
    expect(tuning.enemy('grave_brute')).toBe(tuning.enemy('grave_brute'));
    expect(tuning.enemy('ogre')).toBe(ENEMIES.ogre);
  });
});

/** The same helper data/enemies.ts uses, so exported text can be evaluated the way the file is. */
function monster(
  id: string,
  name: string,
  family: string,
  movement: string,
  base: { life: number; speed: number; radius: number; contact: number; contactCooldown?: number; color: number; range?: number; xp?: number },
  abilities: readonly unknown[] = [],
  traits: object = {},
): object {
  return {
    id,
    name,
    behaviour: 'monster',
    family,
    movement,
    life: base.life,
    moveSpeed: base.speed,
    radius: base.radius,
    contactDamage: base.contact,
    contactCooldown: base.contactCooldown ?? 1,
    color: base.color,
    ...(base.xp !== undefined ? { xp: base.xp } : {}),
    preferredRange: base.range ?? 0,
    abilities,
    traits,
  };
}

function evaluate(entry: string): unknown {
  // The entry is `  key: value,`; wrapping it in braces makes it an object literal again.
  const f: unknown = new Function('monster', `return {\n${entry}\n};`);
  if (typeof f !== 'function') throw new Error('not a function');
  return f(monster);
}

describe('export format', () => {
  it('prints every unmodified monster type as its source definition', () => {
    for (const id of ENEMY_TYPE_IDS) {
      const def: EnemyDef = ENEMIES[id];
      expect(evaluate(enemySource(def)), id).toEqual({ [id]: def });
    }
  });

  it('prints every unmodified minion type as its source definition', () => {
    for (const id of MINION_TYPE_IDS) {
      const def: MinionDef = MINION_DEFS[id];
      expect(evaluate(minionSource(def)), id).toEqual({ [id]: def });
    }
  });

  it('round-trips an overridden type', () => {
    const o = parseEnemyOverride('bone_archer', { life: 50, xp: 1.5, preferredRange: 300, abilities: { '0': { homing: 0.5, bullets: 4 } } });
    if (typeof o === 'string') throw new Error(o);
    const def = resolveEnemy(ENEMIES.bone_archer, o);
    expect(evaluate(enemySource(def))).toEqual({ bone_archer: def });
    const shooter = resolveEnemy(ENEMIES.shooter, { bullets: 5, xp: 2 });
    expect(evaluate(enemySource(shooter))).toEqual({ shooter });
  });

  it('matches the layout of the source file', () => {
    expect(enemySource(ENEMIES.plague_rat)).toBe(
      "  plague_rat: monster('plague_rat', 'Plague Rat', 'swarm', 'flank', { life: 16, speed: 165, radius: 9, contact: 5, contactCooldown: 0.6, color: 0x6e6252 }),",
    );
    expect(enemySource(ENEMIES.grave_brute)).toBe(
      [
        '  grave_brute: monster(',
        "    'grave_brute',",
        "    'Grave Brute',",
        "    'brute',",
        "    'melee',",
        '    { life: 210, speed: 70, radius: 20, contact: 12, contactCooldown: 1.4, color: 0xc8c0a8 },',
        "    [{ kind: 'slam', cooldown: 3.2, range: 90, windup: 0.9, radius: 70, damage: 34 }],",
        '    { knockbackImmune: true },',
        '  ),',
      ].join('\n'),
    );
  });
});
