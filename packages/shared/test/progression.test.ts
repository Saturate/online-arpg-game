import { describe, expect, it } from 'vitest';
import { addXp, createGear, createVessel, levelRequirement, monsterXp, PROGRESSION, Simulation, xpToNext, type GearItem } from '../src/index.js';
import { dealDamage } from '../src/sim/combat.js';
import { spawnEnemy } from '../src/sim/enemies.js';

function player(sim: Simulation, id: number) {
  const p = sim.world.player.get(id);
  if (!p) throw new Error('no player');
  return p;
}

function at(sim: Simulation, id: number) {
  const pos = sim.world.position.get(id);
  if (!pos) throw new Error('no pos');
  return pos;
}

function base(): number {
  return monsterXp({ level: 1, rare: false, boss: false });
}

function give(sim: Simulation, pid: number, item: GearItem): void {
  const p = sim.world.player.get(pid);
  if (!p) throw new Error('no player');
  p.items.set(item.uid, item);
  p.inventory[p.inventory.indexOf(null)] = item.uid;
}

describe('progression', () => {
  it('levels up across thresholds, growing life and Force, and refills them', () => {
    const sim = new Simulation(1, { kind: 'flat' });
    const pid = sim.addPlayer('c', 'warrior');
    const p = sim.world.player.get(pid);
    const h = sim.world.health.get(pid);
    if (!p || !h) throw new Error('no player');
    const life1 = h.maxLife;
    const force1 = p.stats.heatMax;
    h.life = 10;
    addXp(sim, pid, xpToNext(1) + xpToNext(2) + 5);
    expect(p.level).toBe(3);
    expect(p.xp).toBeCloseTo(5);
    expect(h.maxLife).toBeGreaterThan(life1);
    expect(h.life).toBe(h.maxLife);
    expect(p.stats.heatMax).toBe(force1 + 2 * PROGRESSION.forcePerLevel);
    expect(sim.takeEvents().some((e) => e.ev.e === 'levelUp')).toBe(true);
  });

  it('shares kill XP only with the killer\'s party members nearby, with a party bonus', () => {
    const sim = new Simulation(2, { kind: 'flat' });
    const a = sim.addPlayer('a', 'mage');
    const b = sim.addPlayer('b', 'ranger');
    const far = sim.addPlayer('f', 'priest');
    const stranger = sim.addPlayer('s', 'warrior');
    for (const id of [a, b, far]) player(sim, id).party = 'p1';
    const pos = at(sim, a);
    sim.world.position.set(b, { x: pos.x + 50, y: pos.y });
    sim.world.position.set(stranger, { x: pos.x - 50, y: pos.y });
    sim.world.position.set(far, { x: pos.x + PROGRESSION.partyRange + 400, y: pos.y });
    const eid = spawnEnemy(sim, 'chaser', pos.x + 80, pos.y, { rare: false, level: 1, aggro: false });
    dealDamage(sim, eid, 1e9, a, []);
    const each = (base() * (1 + PROGRESSION.partyBonusPerMember)) / 2;
    expect(player(sim, a).xp).toBeCloseTo(each);
    expect(player(sim, b).xp).toBeCloseTo(each);
    expect(player(sim, far).xp).toBe(0);
    expect(player(sim, stranger).xp).toBe(0);
  });

  it('pays the killer alone outside a party, and a party member for a stranger\'s kill gets nothing', () => {
    const sim = new Simulation(2, { kind: 'flat' });
    const a = sim.addPlayer('a', 'mage');
    const b = sim.addPlayer('b', 'ranger');
    player(sim, b).party = 'p1';
    const pos = at(sim, a);
    sim.world.position.set(b, { x: pos.x + 50, y: pos.y });
    const eid = spawnEnemy(sim, 'chaser', pos.x + 80, pos.y, { rare: false, level: 1, aggro: false });
    dealDamage(sim, eid, 1e9, a, []);
    expect(player(sim, a).xp).toBeCloseTo(base());
    expect(player(sim, b).xp).toBe(0);
  });

  it('skips a dead party member, so the living share without the bonus for them', () => {
    const sim = new Simulation(2, { kind: 'flat' });
    const a = sim.addPlayer('a', 'mage');
    const b = sim.addPlayer('b', 'ranger');
    for (const id of [a, b]) player(sim, id).party = 'p1';
    player(sim, b).respawnIn = 3;
    const pos = at(sim, a);
    const eid = spawnEnemy(sim, 'chaser', pos.x + 80, pos.y, { rare: false, level: 1, aggro: false });
    dealDamage(sim, eid, 1e9, a, []);
    expect(player(sim, a).xp).toBeCloseTo(base());
    expect(player(sim, b).xp).toBe(0);
  });

  it('counts a minion\'s killing blow for its master', () => {
    const sim = new Simulation(2, { kind: 'flat' });
    const master = sim.addPlayer('m', 'binder');
    const bystander = sim.addPlayer('s', 'warrior');
    const p = player(sim, master);
    p.stats.spiritMax = 1000;
    const v = createVessel(sim.newItemUid(), sim.rand.loot, 'common', 'zombie_brute');
    p.items.set(v.uid, v);
    p.inventory[p.inventory.indexOf(null)] = v.uid;
    expect(sim.equipVessel(master, v.uid, 0)).toBeNull();
    sim.step();
    const minion = p.minions[0];
    if (minion === null || minion === undefined) throw new Error('no minion');
    const pos = at(sim, master);
    sim.world.position.set(bystander, { x: pos.x + 40, y: pos.y });
    const eid = spawnEnemy(sim, 'chaser', pos.x + 80, pos.y, { rare: false, level: 1, aggro: false });
    const before = p.xp;
    dealDamage(sim, eid, 1e9, minion, []);
    expect(p.xp - before).toBeCloseTo(base());
    expect(player(sim, bystander).xp).toBe(0);
  });

  it('gives a kill with no player behind the last hit to whoever dealt the most damage, or nobody', () => {
    const sim = new Simulation(2, { kind: 'flat' });
    const a = sim.addPlayer('a', 'mage');
    const b = sim.addPlayer('b', 'ranger');
    const pos = at(sim, a);
    sim.world.position.set(b, { x: pos.x + 50, y: pos.y });
    const eid = spawnEnemy(sim, 'chaser', pos.x + 80, pos.y, { rare: false, level: 1, aggro: false });
    const other = spawnEnemy(sim, 'chaser', pos.x + 120, pos.y, { rare: false, level: 1, aggro: false });
    dealDamage(sim, eid, 1, a, []);
    dealDamage(sim, eid, 3, b, []);
    // Another monster lands the killing blow, as a monster's hazard or a reflected shot would.
    dealDamage(sim, eid, 1e9, other, []);
    expect(sim.world.isAlive(eid)).toBe(false);
    expect(player(sim, b).xp).toBeCloseTo(base());
    expect(player(sim, a).xp).toBe(0);

    const untouched = spawnEnemy(sim, 'chaser', pos.x + 80, pos.y, { rare: false, level: 1, aggro: false });
    dealDamage(sim, untouched, 1e9, other, []);
    expect(player(sim, b).xp).toBeCloseTo(base());
    expect(player(sim, a).xp).toBe(0);
  });

  it('multiplies kill XP by the server XP rate', () => {
    const sim = new Simulation(2, { kind: 'flat' });
    sim.rates = { ...sim.rates, xp: 3 };
    const a = sim.addPlayer('a', 'mage');
    const pos = sim.world.position.get(a);
    if (!pos) throw new Error('no pos');
    const eid = spawnEnemy(sim, 'chaser', pos.x + 80, pos.y, { rare: false, level: 1, aggro: false });
    dealDamage(sim, eid, 1e9, a, []);
    expect(sim.world.player.get(a)?.xp).toBeCloseTo(monsterXp({ level: 1, rare: false, boss: false }) * 3);
  });

  it('monsters far below your level are worth almost nothing', () => {
    const sim = new Simulation(3, { kind: 'flat' });
    const pid = sim.addPlayer('c', 'mage');
    const p = sim.world.player.get(pid);
    const pos = sim.world.position.get(pid);
    if (!p || !pos) throw new Error('no player');
    p.level = 30;
    const eid = spawnEnemy(sim, 'chaser', pos.x + 80, pos.y, { rare: false, level: 1, aggro: false });
    dealDamage(sim, eid, 1e9, pid, []);
    expect(p.xp).toBeCloseTo(monsterXp({ level: 1, rare: false, boss: false }) * PROGRESSION.grayFloor);
  });

  it('refuses gear above your level and allows it once you get there', () => {
    const sim = new Simulation(4, { kind: 'flat' });
    const pid = sim.addPlayer('c', 'warrior');
    const helm = createGear(sim.newItemUid(), sim.rand.loot, 'rare', 9, { category: 'helmet' });
    give(sim, pid, helm);
    expect(levelRequirement(helm)).toBe(9 - PROGRESSION.requirementSlack);
    expect(sim.equipGear(pid, helm.uid)).toMatch(/Requires level/);
    addXp(sim, pid, Array.from({ length: 6 }, (_, i) => xpToNext(i + 1)).reduce((a, b) => a + b, 0));
    expect(sim.world.player.get(pid)?.level).toBe(7);
    expect(sim.equipGear(pid, helm.uid)).toBeNull();
  });

  it('keeps level and progress through a save', () => {
    const sim = new Simulation(5, { kind: 'flat' });
    const pid = sim.addPlayer('c', 'binder');
    addXp(sim, pid, xpToNext(1) + 12);
    const save = sim.exportPlayer(pid);
    if (!save) throw new Error('no save');
    const next = new Simulation(6, { kind: 'flat' });
    const again = next.addPlayer('c', 'binder', 'Kay', save);
    expect(next.world.player.get(again)).toMatchObject({ level: 2, xp: 12 });
    expect(next.world.health.get(again)?.maxLife).toBe(sim.world.health.get(pid)?.maxLife);
  });
});

describe('dropped loot', () => {
  it('scatters bags dropped on the same spot so they never stack', () => {
    const sim = new Simulation(9, { kind: 'flat' });
    const pid = sim.addPlayer('c', 'warrior');
    const p = sim.world.player.get(pid);
    if (!p) throw new Error('no player');
    for (let i = 0; i < 4; i++) {
      const g = createGear(sim.newItemUid(), sim.rand.loot, 'magic', 1);
      p.items.set(g.uid, g);
      p.inventory[p.inventory.indexOf(null)] = g.uid;
      expect(sim.discard(pid, g.uid)).toBeNull();
    }
    const spots = [...sim.world.loot.keys()].map((id) => sim.world.position.get(id)).filter((v) => v !== undefined);
    expect(spots).toHaveLength(4);
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        const a = spots[i];
        const b = spots[j];
        if (a && b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(20);
      }
    }
  });
});
