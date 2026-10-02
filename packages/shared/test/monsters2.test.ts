import { describe, expect, it } from 'vitest';
import { BIOMES, bossFor, CURSE, ENEMIES, ENEMY_TYPE_IDS, familyOf, monsterPool, SIM, Simulation, type EnemyTypeId } from '../src/index.js';
import { dealDamage } from '../src/sim/combat.js';
import { packetOf } from '../src/sim/damage.js';
import { spawnEnemy } from '../src/sim/enemies.js';
import { spawnProjectile } from '../src/sim/spells.js';

function setup(seed = 1, desc: ConstructorParameters<typeof Simulation>[1] = { kind: 'flat' }) {
  const sim = new Simulation(seed, desc);
  const pid = sim.addPlayer('c', 'warrior');
  const p = sim.world.player.get(pid);
  const pos = sim.world.position.get(pid);
  if (!p || !pos) throw new Error('no player');
  p.god = true;
  return { sim, pid, pos };
}

const NEW_TYPES: readonly EnemyTypeId[] = [
  'dire_wolf', 'hellhound', 'giant_scorpion', 'thorn_beast', 'cave_spider', 'lizardman', 'scarab', 'carrion_beetle', 'vulture', 'harpy',
  'fire_slime', 'frost_slime', 'fire_elemental', 'frost_elemental', 'storm_elemental', 'will_o_wisp', 'earth_golem', 'bone_golem', 'iron_golem',
  'treant', 'spore_man', 'bog_lurker', 'gargoyle', 'mimic', 'sand_worm', 'mummy', 'ice_wraith', 'imp', 'cultist', 'hellspawn',
  'sand_wyrm', 'treant_king', 'frost_giant',
];

describe('second monster roster', () => {
  it('adds at least 25 types, with the new families present', () => {
    expect(NEW_TYPES.length).toBeGreaterThanOrEqual(25);
    for (const t of NEW_TYPES) expect(ENEMY_TYPE_IDS).toContain(t);
    const families = new Set(NEW_TYPES.map(familyOf));
    for (const f of ['beast', 'elemental', 'golem', 'flyer', 'lurker', 'boss'] as const) expect(families.has(f), f).toBe(true);
  });

  it('every biome offers at least 8 distinct monsters across levels 1 to 30, and something at level 1', () => {
    for (const b of BIOMES) {
      const all = new Set<EnemyTypeId>();
      for (let l = 1; l <= 30; l++) for (const t of monsterPool(b, l)) all.add(t);
      expect(all.size, b).toBeGreaterThanOrEqual(8);
      expect(monsterPool(b, 1).length, `${b} at level 1`).toBeGreaterThan(0);
    }
  });

  it('each biome builds to a fitting boss', () => {
    expect(bossFor('forest', 12)).toBe('treant_king');
    expect(bossFor('desert', 16)).toBe('sand_wyrm');
    expect(bossFor('cave', 22)).toBe('frost_giant');
    for (const b of BIOMES) expect(familyOf(bossFor(b, 20)), b).toBe('boss');
  });

  it('is deterministic for the same seed', () => {
    const trace = (seed: number) => {
      const { sim, pos } = setup(seed);
      const ids = NEW_TYPES.slice(0, 12).map((t, i) => spawnEnemy(sim, t, pos.x + 200 + (i % 4) * 60, pos.y - 120 + Math.floor(i / 4) * 80, { rare: false, level: 5, aggro: true }));
      for (let i = 0; i < 200; i++) sim.step();
      return ids.map((id) => {
        const p = sim.world.position.get(id);
        return p ? `${p.x.toFixed(2)},${p.y.toFixed(2)}` : 'dead';
      });
    };
    expect(trace(7)).toEqual(trace(7));
  });
});

describe('new monster behaviours', () => {
  it('imps blink: they jump to a telegraphed spot around their target', () => {
    const { sim, pos } = setup(3);
    const id = spawnEnemy(sim, 'imp', pos.x + 300, pos.y, { rare: false, level: 3, aggro: true });
    let last = sim.world.position.get(id);
    let jumped = 0;
    let teles = 0;
    for (let i = 0; i < 20 * 12; i++) {
      sim.step();
      for (const ev of sim.takeEvents()) if (ev.ev.e === 'tele' && ev.ev.id === id) teles++;
      const now = sim.world.position.get(id);
      if (last && now && Math.hypot(now.x - last.x, now.y - last.y) > 120) jumped++;
      last = now ? { ...now } : undefined;
    }
    expect(jumped).toBeGreaterThan(0);
    expect(teles).toBeGreaterThan(0);
  });

  it('grave hounds hunt crypts and ruins from level 3 and pounce from range', () => {
    for (const b of ['crypt', 'ruins'] as const) {
      expect(monsterPool(b, 2), b).not.toContain('grave_hound');
      expect(monsterPool(b, 3), b).toContain('grave_hound');
    }
    expect(familyOf('grave_hound')).toBe('beast');
    const { sim, pos } = setup(9);
    const id = spawnEnemy(sim, 'grave_hound', pos.x + 320, pos.y, { rare: false, level: 3, aggro: true });
    const hound = sim.world.enemy.get(id);
    if (!hound) throw new Error('no hound');
    // The spawn cooldown is random; a ready pounce keeps the test from depending on it.
    hound.cooldowns[0] = 0;
    let teles = 0;
    for (let i = 0; i < 20; i++) {
      sim.step();
      for (const ev of sim.takeEvents()) if (ev.ev.e === 'tele' && ev.ev.id === id) teles++;
    }
    expect(teles).toBeGreaterThan(0);
  });

  it('chargers roam the first regions out of town from level 6', () => {
    for (const b of ['marsh', 'ruins', 'forest'] as const) {
      expect(monsterPool(b, 5), b).not.toContain('charger');
      expect(monsterPool(b, 6), b).toContain('charger');
    }
    for (const b of ['meadow', 'crypt', 'desert', 'cave'] as const) expect(monsterPool(b, 25), b).not.toContain('charger');
    expect(familyOf('charger')).toBe('charger');
  });

  it('a charger fights for 15 seconds the same way every time', () => {
    const trace = () => {
      const { sim, pos } = setup(12);
      const id = spawnEnemy(sim, 'charger', pos.x + 300, pos.y, { rare: false, level: 6, aggro: true });
      const out: string[] = [];
      for (let i = 0; i < 15 * SIM.tickRate; i++) {
        sim.step();
        for (const { ev } of sim.takeEvents()) if ((ev.e === 'tele' || ev.e === 'attack') && ev.id === id) out.push(`${i}:${ev.e}`);
      }
      const p = sim.world.position.get(id);
      out.push(p ? `${p.x.toFixed(2)},${p.y.toFixed(2)}` : 'gone');
      return out;
    };
    const first = trace();
    expect(first.some((s) => s.endsWith(':tele'))).toBe(true);
    expect(trace()).toEqual(first);
  });

  /** Spawns a charger with its charge ready; `dodge` runs once, on the charge's telegraph. */
  function charge(dodge: (pos: { x: number; y: number }) => void) {
    const { sim, pid, pos } = setup(13);
    const player = sim.world.player.get(pid);
    if (!player) throw new Error('no player');
    player.god = false;
    const id = spawnEnemy(sim, 'charger', pos.x + 330, pos.y, { rare: false, level: 6, aggro: true });
    const e = sim.world.enemy.get(id);
    const def = ENEMIES.charger;
    const ability = def.behaviour === 'monster' ? def.abilities[0] : undefined;
    if (!e || ability?.kind !== 'charge') throw new Error('no charge');
    // The spawn cooldown is random; a ready charge keeps the test from depending on it.
    e.cooldowns[0] = 0;
    let tele: { tick: number; life: number; line: boolean } | null = null;
    for (let i = 0; i < 2 * SIM.tickRate && !tele; i++) {
      sim.step();
      for (const { ev } of sim.takeEvents()) {
        if (ev.e === 'tele' && ev.id === id && !tele) {
          tele = { tick: i, life: sim.world.health.get(pid)?.life ?? -1, line: ev.shape === 'line' };
          dodge(pos);
        }
      }
    }
    if (!tele) throw new Error('the charger never telegraphed');
    // Through the wind-up and the dash, but not the walk back to the player afterwards.
    const ticks = Math.ceil((ability.windup + ability.duration) * SIM.tickRate) + 2;
    for (let i = 0; i < ticks; i++) sim.step();
    // One charge hit at this level, as the same hero takes it (armour and Iron Skin included).
    const ref = setup(13);
    const refPlayer = ref.sim.world.player.get(ref.pid);
    if (!refPlayer) throw new Error('no player');
    refPlayer.god = false;
    for (let i = 0; i < tele.tick + ticks; i++) ref.sim.step();
    const refBefore = ref.sim.world.health.get(ref.pid)?.life ?? 0;
    dealDamage(ref.sim, ref.pid, packetOf('physical', ability.damage * e.damageMult), ref.pid);
    const expected = refBefore - (ref.sim.world.health.get(ref.pid)?.life ?? 0);
    return { tele, lifeAfter: sim.world.health.get(pid)?.life ?? -1, expected };
  }

  it("a charger's charge is a telegraphed line that a step aside dodges", () => {
    const stood = charge(() => {});
    expect(stood.tele.line).toBe(true);
    expect(stood.tele.life - stood.lifeAfter).toBeCloseTo(stood.expected, 1);
    const dodged = charge((pos) => {
      pos.y += 220;
    });
    expect(dodged.lifeAfter).toBe(dodged.tele.life);
  });

  it("a charger's range is its dash, so it never charges at someone the dash cannot reach", () => {
    const def = ENEMIES.charger;
    const a = def.behaviour === 'monster' ? def.abilities[0] : undefined;
    if (a?.kind !== 'charge') throw new Error('no charge');
    expect(a.range).toBeCloseTo(a.speed * a.duration);
  });

  it("a bolt aimed at a charger's flank or tail hits, on whichever side its body is", () => {
    // A side shot `offset` units along the x axis from its collider, which faces `facing`.
    const shoot = (facing: number, offset: number) => {
      const { sim, pid, pos } = setup(14);
      const id = spawnEnemy(sim, 'charger', pos.x + 700, pos.y, { rare: false, level: 6, aggro: false });
      const e = sim.world.enemy.get(id);
      const epos = sim.world.position.get(id);
      if (!e || !epos) throw new Error('no charger');
      e.facing = facing;
      const before = sim.world.health.get(id)?.life ?? 0;
      spawnProjectile(sim, { ownerId: pid, team: 'players', x: epos.x + offset, y: epos.y + 120, angle: -Math.PI / 2, speed: 900, radius: 6, range: 300, damage: packetOf('physical', 20) });
      for (let i = 0; i < 10; i++) sim.step();
      return before - (sim.world.health.get(id)?.life ?? 0);
    };
    // Facing +x, the trunk and tail lie toward -x; well clear of the 26-unit collider either way.
    expect(shoot(0, -45)).toBeGreaterThan(0);
    expect(shoot(0, -110)).toBeGreaterThan(0);
    expect(shoot(0, 80)).toBe(0);
    expect(shoot(Math.PI, 80)).toBeGreaterThan(0);
    expect(shoot(Math.PI, -110)).toBe(0);
  });

  it('gargoyles hold perfectly still until a player comes close, then wake', () => {
    const { sim, pid, pos } = setup(4);
    const def = ENEMIES.gargoyle;
    if (def.behaviour !== 'monster' || !def.traits.dormant) throw new Error('gargoyle is not dormant');
    const wake = def.traits.dormant.wakeRange;
    const id = spawnEnemy(sim, 'gargoyle', pos.x + wake + 150, pos.y, { rare: false, level: 3, aggro: false });
    const start = { ...(sim.world.position.get(id) ?? { x: 0, y: 0 }) };
    for (let i = 0; i < 60; i++) sim.step();
    const still = sim.world.position.get(id);
    expect(still).toEqual(start);
    expect(sim.world.enemy.get(id)?.aggro).toBe(false);
    sim.world.position.set(pid, { x: start.x - wake + 40, y: start.y });
    sim.step();
    expect(sim.world.enemy.get(id)?.aggro).toBe(true);
  });

  it('a dormant mimic wakes when hit, even from far away', () => {
    const { sim, pid, pos } = setup(5);
    const id = spawnEnemy(sim, 'mimic', pos.x + 400, pos.y, { rare: false, level: 4, aggro: false });
    dealDamage(sim, id, packetOf('physical', 5), pid);
    expect(sim.world.enemy.get(id)?.aggro).toBe(true);
  });

  it("a mummy's curse weakens nearby players' hits, and fades after they leave", () => {
    const { sim, pid, pos } = setup(6);
    const dummy = spawnEnemy(sim, 'earth_golem', pos.x + 600, pos.y, { rare: false, level: 1, aggro: false });
    const before = dealDamage(sim, dummy, packetOf('physical', 100), pid, { ignoreArmor: true, quiet: true });
    spawnEnemy(sim, 'mummy', pos.x + 80, pos.y, { rare: false, level: 3, aggro: true });
    sim.step();
    expect(sim.world.status.get(pid)?.curse).toBeGreaterThan(0);
    const after = dealDamage(sim, dummy, packetOf('physical', 100), pid, { ignoreArmor: true, quiet: true });
    expect(after).toBeCloseTo(before * (1 - CURSE.damageReduction), 5);
    for (const [eid, e] of sim.world.enemy) if (e.typeId === 'mummy') sim.world.destroy(eid);
    sim.world.flushDestroyed();
    for (let i = 0; i < 30; i++) sim.step();
    expect(sim.world.status.get(pid)?.curse).toBe(0);
  });

  it('flyers hover over water that pushes walkers back out', () => {
    const { sim } = setup(8, { kind: 'testground' });
    // A segment well inside the map, away from the edge clamp.
    const water = sim.mapDef.obstacles.find((o) => o.kind === 'water' && o.shape.type === 'capsule' && o.shape.ay > 400 && o.shape.ay < sim.map.height - 400);
    if (!water || water.shape.type !== 'capsule') throw new Error('arena has no river');
    // A little off the river's centre line, where the push-out direction is well defined.
    const x = (water.shape.ax + water.shape.bx) / 2 + 8;
    const y = (water.shape.ay + water.shape.by) / 2;
    const bird = spawnEnemy(sim, 'vulture', x, y, { rare: false, level: 1, aggro: false });
    const wolf = spawnEnemy(sim, 'dire_wolf', x, y, { rare: false, level: 1, aggro: false });
    // Spawning snaps to open ground; put both on the water on purpose.
    sim.world.position.set(bird, { x, y });
    sim.world.position.set(wolf, { x, y });
    sim.step();
    const bp = sim.world.position.get(bird);
    const wp = sim.world.position.get(wolf);
    if (!bp || !wp) throw new Error('lost them');
    expect(sim.map.pointBlocked(bp.x, bp.y, 4, 'move')).toBe(true);
    expect(sim.map.pointBlocked(wp.x, wp.y, 1, 'move')).toBe(false);
  });
});

describe('starter monsters', () => {
  const volley = (level: number, rare = false): number => {
    const { sim, pos } = setup(3);
    const id = spawnEnemy(sim, 'shooter', pos.x + 200, pos.y, { rare, level, aggro: true });
    for (let t = 0; t < 200; t++) {
      sim.step();
      const shots = [...sim.world.projectile.values()].filter((p) => p.ownerId === id).length;
      if (shots > 0) return shots;
    }
    return 0;
  };

  it('fire a single projectile below the multishot level, and spreads from it on', () => {
    expect(volley(1)).toBe(1);
    expect(volley(5)).toBeGreaterThan(1);
  });

  it('never roll Multishot while low level', () => {
    const { sim, pos } = setup(4);
    for (let i = 0; i < 60; i++) {
      const id = spawnEnemy(sim, 'shooter', pos.x + 300, pos.y + i, { rare: true, level: 2, aggro: false });
      expect(sim.world.enemy.get(id)?.affixes.some((a) => a.id === 'extra_projectiles')).toBe(false);
    }
  });
});

describe('bosses', () => {
  it('never regenerate', () => {
    const { sim, pos } = setup(9);
    for (let i = 0; i < 40; i++) {
      const id = spawnEnemy(sim, 'chaser', pos.x + 300, pos.y + i * 5, { rare: true, boss: true, level: 8, aggro: false });
      expect(sim.world.enemy.get(id)?.affixes.some((a) => a.id === 'regenerating')).toBe(false);
    }
  });
});
