import { describe, expect, it } from 'vitest';
import { HOUND_PACK, ITEM_TIERS, MINION_DEFS, MINIONS, SIM, Simulation, createBrothersCreation, createVessel, vesselSpirit, type EntityId, type VesselItem } from '../src/index.js';
import { spiritReservedFor } from '../src/sim/auras.js';
import { dealDamage } from '../src/sim/combat.js';
import { spawnEnemy } from '../src/sim/enemies.js';
import { Rng } from '../src/sim/rng.js';

function binder() {
  const sim = new Simulation(11, { kind: 'flat' });
  const id = sim.addPlayer('c1', 'binder');
  const p = sim.world.player.get(id)!;
  // Room for several packs; spirit rules are tested on their own below.
  p.stats.spiritMax = 1000;
  p.level = 30;
  sim.step();
  return { sim, id, p };
}

function give(sim: Simulation, id: EntityId, v: VesselItem): void {
  const p = sim.world.player.get(id)!;
  p.items.set(v.uid, v);
  p.inventory[p.inventory.indexOf(null)] = v.uid;
}

function hound(sim: Simulation, pack: number, tier: VesselItem['tier'] = 'relic'): VesselItem {
  return { ...createVessel(sim.newItemUid(), sim.rng, tier, 'hound', 1), affixes: [], pack };
}

function dogsOf(sim: Simulation, owner: EntityId): number {
  let n = 0;
  for (const m of sim.world.minion.values()) if (m.ownerId === owner && m.pack) n++;
  return n;
}

function stepSeconds(sim: Simulation, s: number): void {
  for (let i = 0; i < Math.round(s * SIM.tickRate); i++) sim.step();
}

describe('the Hound pack', () => {
  it('rolls pack size by tier from the table', () => {
    const rng = new Rng(5);
    for (const tier of ITEM_TIERS) {
      const seen = new Set<number>();
      for (let i = 0; i < 300; i++) seen.add(createVessel(i, rng, tier, 'hound').pack ?? -1);
      const { min, max } = HOUND_PACK.packmatesByTier[tier];
      expect(Math.min(...seen), tier).toBe(min);
      expect(Math.max(...seen), tier).toBe(max);
    }
    // Other minions carry no pack roll.
    expect(createVessel(1, rng, 'relic', 'wraith').pack).toBeUndefined();
  });

  it('binds a Leader and its packmates for one vessel of spirit', () => {
    const { sim, id, p } = binder();
    const v = hound(sim, 4);
    give(sim, id, v);
    const before = spiritReservedFor(p);
    expect(sim.equipVessel(id, v.uid, 1)).toBeNull();
    sim.step();
    expect(spiritReservedFor(p) - before).toBe(vesselSpirit(v));
    const leaderId = p.minions[1]!;
    const leader = sim.world.minion.get(leaderId)!;
    expect(leader.pack?.role).toBe('leader');
    expect(p.packs[1]!.mates).toHaveLength(4);
    const mate = sim.world.minion.get(p.packs[1]!.mates[0]!)!;
    // The Leader is bigger and tougher, packmates smaller, faster and weaker.
    expect(sim.world.radius.get(leaderId)!).toBeGreaterThan(MINION_DEFS.hound.radius);
    expect(sim.world.radius.get(p.packs[1]!.mates[0]!)!).toBeLessThan(MINION_DEFS.hound.radius);
    expect(sim.world.health.get(leaderId)!.maxLife).toBeGreaterThan(sim.world.health.get(p.packs[1]!.mates[0]!)!.maxLife);
    expect(mate.moveSpeed).toBeGreaterThan(leader.moveSpeed);
    expect(mate.damage).toBeLessThan(leader.damage);
    // Unbinding sends the whole pack away.
    expect(sim.unequipVessel(id, 1)).toBeNull();
    sim.step();
    expect(dogsOf(sim, id)).toBe(0);
  });

  it('scales packmates so a big pack is not six hounds', () => {
    const { sim, id, p } = binder();
    const small = hound(sim, 1);
    const big = hound(sim, 6);
    give(sim, id, small);
    give(sim, id, big);
    sim.equipVessel(id, small.uid, 1);
    sim.equipVessel(id, big.uid, 2);
    sim.step();
    const life = (slot: number) => p.packs[slot]!.mates.reduce((sum, m) => sum + sim.world.health.get(m)!.maxLife, 0);
    const leaderLife = sim.world.health.get(p.minions[1]!)!.maxLife;
    // One packmate is 0.55 of a base hound; six together are 1.35 of one, not 6.
    expect(life(2) / life(1)).toBeCloseTo(Math.sqrt(6), 0);
    expect(life(2)).toBeLessThan(leaderLife * 1.2);
  });

  it('never fields more than 12 dogs across vessels', () => {
    const { sim, id, p } = binder();
    const vessels = [hound(sim, 6), hound(sim, 6), hound(sim, 6)];
    vessels.forEach((v, i) => {
      give(sim, id, v);
      expect(sim.equipVessel(id, v.uid, i + 1)).toBeNull();
    });
    sim.step();
    sim.step();
    expect(dogsOf(sim, id)).toBe(HOUND_PACK.maxDogs);
    // Every vessel keeps its Leader; the packmates share what is left, in warband order.
    for (let slot = 1; slot <= 3; slot++) expect(p.minions[slot]).not.toBeNull();
    expect(p.packs.map((s) => s.mates.length).slice(1, 4)).toEqual([6, 3, 0]);
    // Freeing a pack gives the others their packmates back at once.
    sim.unequipVessel(id, 1);
    sim.step();
    expect(p.packs.map((s) => s.mates.length).slice(1, 4)).toEqual([0, 6, 4]);
    expect(dogsOf(sim, id)).toBe(HOUND_PACK.maxDogs);
  });

  it('refuses a pack vessel when every dog place is a Leader already', () => {
    const { sim, id } = binder();
    for (let i = 0; i < HOUND_PACK.maxDogs; i++) {
      const v = hound(sim, 1, 'common');
      give(sim, id, v);
      expect(sim.equipVessel(id, v.uid, i + 1)).toBeNull();
    }
    const extra = hound(sim, 1, 'common');
    give(sim, id, extra);
    expect(sim.equipVessel(id, extra.uid, 20)).toMatch(/pack limit/);
  });

  it('fights on without its Leader, softer and without the howl, and the dead return with the Leader', () => {
    const { sim, id, p } = binder();
    const v = hound(sim, 3);
    give(sim, id, v);
    sim.equipVessel(id, v.uid, 1);
    sim.step();
    const pack = p.packs[1]!;
    const leaderId = p.minions[1]!;
    const deadMate = pack.mates[0]!;
    const mates = [...pack.mates];
    for (const m of mates) sim.world.minion.get(m)!.howled = 5;
    dealDamage(sim, deadMate, 1e6, id, []);
    dealDamage(sim, leaderId, 1e6, id, []);
    sim.step();
    expect(p.minions[1]).toBeNull();
    expect(pack.mates).toHaveLength(2);
    expect(pack.down).toHaveLength(1);
    // The survivors lose the howl buff with their Leader.
    for (const m of pack.mates) expect(sim.world.minion.get(m)!.howled).toBe(0);
    // They still fight: a monster close by gets bitten.
    const pos = sim.world.position.get(id)!;
    const e = spawnEnemy(sim, 'bone_golem', pos.x + 60, pos.y, { rare: false, level: 1, aggro: false });
    const eh = sim.world.health.get(e)!;
    eh.maxLife = 1e6;
    eh.life = 1e6;
    sim.world.enemy.get(e)!.pinned = 999;
    stepSeconds(sim, 2);
    expect(eh.life).toBeLessThan(1e6);
    // After the respawn time the Leader returns, with the dead packmate.
    stepSeconds(sim, MINIONS.respawnSeconds);
    expect(p.minions[1]).not.toBeNull();
    expect(pack.mates).toHaveLength(3);
    expect(pack.down).toHaveLength(0);
  });

  it('packmates follow the Leader to its target and their bites poison', () => {
    const { sim, id, p } = binder();
    const v = hound(sim, 2);
    give(sim, id, v);
    sim.equipVessel(id, v.uid, 1);
    sim.step();
    const pos = sim.world.position.get(id)!;
    const near = spawnEnemy(sim, 'bone_golem', pos.x + 150, pos.y, { rare: false, level: 1, aggro: false });
    const far = spawnEnemy(sim, 'bone_golem', pos.x - 160, pos.y, { rare: false, level: 1, aggro: false });
    for (const e of [near, far]) {
      sim.world.health.get(e)!.life = 1e6;
      sim.world.health.get(e)!.maxLife = 1e6;
      sim.world.enemy.get(e)!.pinned = 999;
    }
    const leader = sim.world.minion.get(p.minions[1]!)!;
    leader.targetId = far;
    leader.leapCooldown = 99;
    sim.step();
    for (const m of p.packs[1]!.mates) expect(sim.world.minion.get(m)!.targetId).toBe(far);
    stepSeconds(sim, 3);
    expect(sim.world.status.get(far)!.poison.length).toBeGreaterThan(0);
  });

  it('the Leader pounces, pinning and poisoning, and howls; Follow uses neither', () => {
    const { sim, id, p } = binder();
    const v = hound(sim, 1);
    give(sim, id, v);
    sim.equipVessel(id, v.uid, 1);
    sim.step();
    const lpos = sim.world.position.get(p.minions[1]!)!;
    const e = spawnEnemy(sim, 'dire_wolf', lpos.x + 300, lpos.y, { rare: false, level: 1, aggro: false });
    sim.world.health.get(e)!.life = 1e6;
    sim.world.health.get(e)!.maxLife = 1e6;
    const leader = sim.world.minion.get(p.minions[1]!)!;
    leader.leapCooldown = 0;
    leader.targetId = e;
    const kinds = new Set<string>();
    for (let i = 0; i < 40; i++) {
      sim.step();
      for (const ev of sim.takeEvents()) kinds.add(ev.ev.e);
    }
    expect(kinds.has('pounce')).toBe(true);
    expect(kinds.has('howl')).toBe(true);
    expect(sim.world.status.get(e)!.poison.length).toBeGreaterThan(0);

    p.stance = 'follow';
    leader.leapCooldown = 0;
    leader.howlCooldown = 0;
    kinds.clear();
    for (let i = 0; i < 60; i++) {
      sim.step();
      for (const ev of sim.takeEvents()) kinds.add(ev.ev.e);
    }
    expect(kinds.has('pounce')).toBe(false);
    expect(kinds.has('howl')).toBe(false);
    for (const m of sim.world.minion.values()) expect(m.targetId).toBeNull();
  });

  it('Brothers Creation is a relic Hound vessel with the full pack and a fixed name', () => {
    const v = createBrothersCreation(7, 1);
    expect(v).toMatchObject({ uid: 7, kind: 'vessel', tier: 'relic', minion: 'hound', name: 'Brothers Creation', pack: 6, fixedName: true });
    expect(v.lore).toMatch(/brothers/);
    expect(v.bound).toBeUndefined();
    const { sim, id, p } = binder();
    const own = createBrothersCreation(sim.newItemUid(), 1);
    give(sim, id, own);
    expect(sim.equipVessel(id, own.uid, 1)).toBeNull();
    sim.step();
    expect(p.packs[1]!.mates).toHaveLength(6);
    expect(dogsOf(sim, id)).toBe(7);
  });
});
