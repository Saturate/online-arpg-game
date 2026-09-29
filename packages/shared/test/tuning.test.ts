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
  killScore,
  killXp,
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
    expect(parseEnemyOverride('ogre', { life: 400, moveSpeed: 62, abilities: { '1': { kind: 'slam', cooldown: 5, damage: 26 } } })).toEqual({ life: 400, abilities: { '1': { kind: 'slam', cooldown: 5 } } });
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
    expect(parseEnemyOverride('ogre', { abilities: { '2': { kind: 'slam', cooldown: 1 } } })).toMatch(/no ability 2/);
    expect(parseEnemyOverride('ogre', { abilities: { '0': { kind: 'slam', bullets: 3 } } })).toMatch(/slam ability has no field "bullets"/);
    expect(parseEnemyOverride('bone_archer', { abilities: { '0': { kind: 'shoot', bullets: 2.5 } } })).toMatch(/whole number/);
    expect(parseEnemyOverride('ogre', { abilities: [] })).toMatch(/object/);
    expect(parseEnemyOverride('ogre', { model: 'hero_mage' })).toMatch(/model/);
    expect(parseEnemyOverride('ogre', { height: 2000 })).toMatch(/between/);
    // Index keys are plain numbers, so two spellings of one ability cannot both arrive.
    expect(parseEnemyOverride('ogre', { abilities: { '01': { kind: 'slam', cooldown: 5 }, '1': { kind: 'slam', cooldown: 6 } } })).toMatch(/plain number/);
    expect(parseEnemyOverride('ogre', { abilities: { '0': { cooldown: 5 } } })).toMatch(/is for a undefined ability/);
    expect(parseEnemyOverride('ogre', { abilities: { '0': { kind: 'shoot', cooldown: 5 } } })).toMatch(/is a slam/);
    // A procedural type has no model file for a height to size.
    expect(parseEnemyOverride('dire_wolf', { height: 40 })).toMatch(/pick a model first/);
    expect(parseEnemyOverride('dire_wolf', { model: 'mon_ghoul', height: 40 })).toEqual({ model: 'mon_ghoul', height: 40 });
    expect(parseMinionOverride('wraith', { height: 60 })).toMatch(/pick a model first/);
    expect(parseMinionOverride('skeleton_archer', { projectileSpeed: 0 })).toMatch(/between 10/);
    expect(parseEnemyOverride('ogre', null)).toMatch(/object/);
    expect(parseMinionOverride('zombie_brute', { ranged: true })).toMatch(/no field "ranged"/);
  });

  it('keeps ability cooldowns from reaching zero, except where the code has zero', () => {
    expect(parseEnemyOverride('bone_archer', { abilities: { '0': { kind: 'shoot', cooldown: 0 } } })).toMatch(/at least 0.1/);
    expect(parseEnemyOverride('bone_spire', { abilities: { '0': { kind: 'ring', cooldown: 0.05, windup: 0 } } })).toMatch(/at least 0.1/);
    expect(parseEnemyOverride('bone_spire', { abilities: { '0': { kind: 'ring', cooldown: 0.1, windup: 0 } } })).toEqual({ abilities: { '0': { kind: 'ring', cooldown: 0.1, windup: 0 } } });
    expect(parseEnemyOverride('ogre', { abilities: { '0': { kind: 'slam', cooldown: 0 } } })).toMatch(/at least 0.1/);
    // The volatile's suicide blast has cooldown 0 in the code, so it may keep it.
    expect(parseEnemyOverride('volatile', { abilities: { '0': { kind: 'explode', cooldown: 0, damage: 50 } } })).toEqual({ abilities: { '0': { kind: 'explode', damage: 50 } } });
  });

  it('drops only a stored ability patch whose kind no longer matches', () => {
    const warnings: string[] = [];
    const t = parseTuningOverrides({ monsters: { ogre: { life: 500, abilities: { '0': { kind: 'shoot', cooldown: 5 }, '1': { kind: 'slam', damage: 30 }, '7': { kind: 'slam', damage: 1 } } } }, minions: {} }, (w) => warnings.push(w));
    expect(t.monsters.ogre).toEqual({ life: 500, abilities: { '1': { kind: 'slam', damage: 30 } } });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/ogre: dropped an ability patch/);
    // And the resolver never lands a patch on an ability of another kind.
    const def = resolveEnemy(ENEMIES.ogre, { abilities: { '0': { kind: 'shoot', damage: 999 } } });
    expect(def.behaviour === 'monster' ? def.abilities[0] : null).toBe(ENEMIES.ogre.behaviour === 'monster' ? ENEMIES.ogre.abilities[0] : null);
  });

  it('skips stored types that no longer pass instead of dropping everything', () => {
    const warnings: string[] = [];
    const t = parseTuningOverrides({ monsters: { ogre: { life: 500 }, dragon: { life: 1 }, chaser: { life: -1 } }, minions: { wraith: { damage: 30 } } }, (w) => warnings.push(w));
    expect(t).toEqual({ monsters: { ogre: { life: 500 } }, minions: { wraith: { damage: 30 } } });
    expect(warnings).toHaveLength(2);
  });

  it('sends only models and heights to game clients, and checks them on arrival', () => {
    const t: TuningOverrides = { monsters: { ogre: { life: 500, model: 'mon_butcher' }, chaser: { life: 50 } }, minions: { skeleton_archer: { height: 60 } } };
    const m = modelOverridesOf(t);
    expect(m).toEqual({ monsters: { ogre: { model: 'mon_butcher' } }, minions: { skeleton_archer: { height: 60 } } });
    expect(parseModelOverrides(JSON.parse(JSON.stringify(m)))).toEqual(m);
    expect(parseModelOverrides({ monsters: { ogre: { life: 5 } }, minions: {} })).toMatch(/unknown field/);
    expect(parseModelOverrides({ monsters: { ogre: { model: '../x' } }, minions: {} })).toMatch(/model/);
  });
});

describe('override layer at spawn', () => {
  const tuning = new MonsterTuning({
    monsters: { grave_brute: { life: 999, moveSpeed: 10, radius: 30, contactDamage: 50, xp: 3, abilities: { '0': { kind: 'slam', damage: 77, cooldown: 9 } } } },
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

  it('scales kill XP by the multiplier but leaves Arena score alone', () => {
    const sim = new Simulation(1, { kind: 'flat' }, {}, tuning);
    const e = sim.world.enemy.get(sim.spawnEnemy('grave_brute', 400, 400));
    if (!e) throw new Error('no enemy');
    const base = monsterXp({ level: 1, rare: false, boss: false });
    expect(killXp(e)).toBeCloseTo(base * 3);
    expect(killScore(e)).toBe(Math.round(base));
  });

  it('never fires a minion shot that cannot expire', () => {
    // Past validation on purpose: the spawn guard is the last line if a zero speed ever gets in.
    const slow = new MonsterTuning({ monsters: {}, minions: { skeleton_archer: { projectileSpeed: 0 } } });
    expect(slow.minion('skeleton_archer').projectileSpeed).toBe(0);
    const sim = new Simulation(1, { kind: 'flat' }, {}, slow);
    const pid = sim.addPlayer('c', 'binder');
    // Binders start with a melee brute; turning the vessel into an archer's gives a ranged minion.
    const p = sim.world.player.get(pid);
    const uid = p?.warband.find((u) => u !== null);
    const vessel = uid === undefined || uid === null ? undefined : p?.items.get(uid);
    if (vessel?.kind !== 'vessel') throw new Error('binder has no vessel');
    vessel.minion = 'skeleton_archer';
    sim.step();
    const pos = sim.world.position.get(pid);
    if (!pos) throw new Error('no player');
    sim.spawnEnemy('chaser', pos.x + 200, pos.y);
    let lifetimes: number[] = [];
    for (let i = 0; i < 200 && lifetimes.length === 0; i++) {
      sim.step();
      lifetimes = [...sim.world.projectile.entries()].filter(([id]) => sim.world.minion.has(sim.world.projectile.get(id)?.ownerId ?? -1)).map(([, p]) => p.lifetime);
    }
    expect(lifetimes.length).toBeGreaterThan(0);
    for (const l of lifetimes) expect(Number.isFinite(l)).toBe(true);
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
    const o = parseEnemyOverride('bone_archer', { life: 50, xp: 1.5, preferredRange: 300, abilities: { '0': { kind: 'shoot', homing: 0.5, bullets: 4 } } });
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
