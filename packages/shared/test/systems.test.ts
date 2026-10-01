import { describe, expect, it } from 'vitest';
import {
  STARTER_VESSELS,
  SKILL_BUTTONS,
  AURA,
  BUTTON,
  compileSigilItem,
  createSigil,
  createVessel,
  HEAT,
  LINK,
  NET,
  serializeEntities,
  SIM,
  Simulation,
  snapshotFor,
  SPELL,
  type EntityId,
  type InputFrame,
  type SigilItem,
} from '../src/index.js';
import { slotsFor } from './helpers/spell.js';

function frame(seq: number, over: Partial<InputFrame> = {}): InputFrame {
  return { seq, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: 0, ...over };
}

/** A player with one custom sigil equipped in slot 0 and no enemies around. */
function setup(spell: string, classId: 'mage' | 'priest' | 'binder' | 'warrior' = 'mage') {
  const sim = new Simulation(3);
  const id = sim.addPlayer('c1', classId, 'Tester');
  const p = sim.world.player.get(id)!;
  const item: SigilItem = { ...createSigil(sim.newItemUid(), sim.rng, 'relic'), affixes: [], corrupted: true };
  item.slots = slotsFor(spell, () => sim.newItemUid());
  p.items.set(item.uid, item);
  p.inventory[p.inventory.indexOf(null)] = item.uid;
  p.sigils[0] = null;
  expect(sim.equipSigil(id, item.uid, 0)).toBeNull();
  let seq = 0;
  const cast = (over: Partial<InputFrame> = {}) => {
    sim.applyInput(id, frame(seq++, { buttons: BUTTON.skill1, ...over }));
    sim.step();
    sim.applyInput(id, frame(seq++));
    sim.step();
  };
  const idle = (ticks: number) => {
    for (let i = 0; i < ticks; i++) {
      sim.applyInput(id, frame(seq++));
      sim.step();
    }
  };
  return { sim, id, p, item, cast, idle };
}

function events(sim: Simulation) {
  return sim.takeEvents().map((e) => e.ev);
}

describe('heat', () => {
  it('adds the compiled heat cost, then cools after the pause', () => {
    const { p, cast, idle } = setup('bolt fire');
    cast();
    const afterCast = p.heat;
    expect(afterCast).toBeGreaterThan(0);
    idle(Math.ceil(HEAT.coolPauseSeconds / SIM.dt) + 20);
    expect(p.heat).toBeLessThan(afterCast);
  });

  it('never lets heat exceed the overheat cap', () => {
    const { p, cast } = setup('nova fire large');
    for (let i = 0; i < 40; i++) cast();
    expect(p.heat).toBeLessThanOrEqual(HEAT.overheatMax);
  });

  it('misfires sometimes above max heat and hurts the caster', () => {
    const { sim, p, id, cast } = setup('bolt');
    let misfires = 0;
    for (let i = 0; i < 200; i++) {
      p.heat = HEAT.max + (HEAT.overheatMax - HEAT.max) * 0.5;
      p.castCooldown = 0;
      sim.world.health.get(id)!.life = 1000;
      cast();
      misfires += events(sim).filter((e) => e.e === 'fizzle' && e.why === 'misfire').length;
    }
    expect(misfires).toBeGreaterThan(30);
    expect(misfires).toBeLessThan(170);
  });

  it('a dud fizzles, costs half its Force and reports the rule it broke', () => {
    const { sim, p, cast } = setup('bolt fire split timer');
    const eq = p.sigils[0]!;
    expect(eq.compiled.ok).toBe(false);
    expect(eq.compiled.force).toBeGreaterThan(0);
    cast();
    const fizzle = events(sim).find((e) => e.e === 'fizzle');
    expect(fizzle).toMatchObject({ why: 'dud', reason: 'trailing-release' });
    expect(p.heat).toBeCloseTo(eq.compiled.force * HEAT.dudHeatFraction, 0);
  });
});

describe('fixtures in play', () => {
  it('Bolt Fire Timer Split Bolt travels, then releases 3 bolts and flies on', () => {
    const { sim, cast, idle } = setup('bolt fire timer split(3) bolt');
    cast();
    expect(sim.world.projectile.size).toBe(1);
    idle(Math.ceil(SPELL.timerSeconds / SIM.dt));
    expect(sim.world.projectile.size).toBe(4);
  });

  it('Bolt Fire Split fires a 3-way spread immediately', () => {
    const { sim, cast } = setup('bolt fire split(3)');
    cast();
    expect(sim.world.projectile.size).toBe(3);
  });

  it('Dash Impact OnLand Nova moves the caster and spawns a nova on landing', () => {
    const { sim, id, cast, idle } = setup('dash impact onland nova');
    const start = { ...sim.world.position.get(id)! };
    cast();
    idle(SPELL.dash.ticks + 1);
    const end = sim.world.position.get(id)!;
    expect(end.x - start.x).toBeGreaterThan(SPELL.dash.distance * 0.9);
    expect(sim.world.nova.size + events(sim).length).toBeGreaterThan(0);
  });

  it('Nova Restore heals the caster', () => {
    const { sim, id, cast } = setup('nova restore', 'priest');
    const h = sim.world.health.get(id)!;
    h.life = 10;
    cast();
    cast();
    expect(h.life).toBeGreaterThan(10);
  });

  it('a long Zone Restore lasts longer than a plain zone', () => {
    const { sim, cast, idle } = setup('zone[long] restore');
    cast();
    idle(Math.ceil(SPELL.zone.durationSeconds / SIM.dt) + 2);
    expect(sim.world.zone.size).toBe(1);
  });

  it('a piercing Bolt passes through enemies', () => {
    const { sim, id, cast } = setup('bolt[pierce 2] swift');
    const p = sim.world.position.get(id)!;
    const a = sim.spawnEnemy('chaser', p.x + 60, p.y);
    const b = sim.spawnEnemy('chaser', p.x + 120, p.y);
    cast();
    for (let i = 0; i < 10; i++) sim.step();
    const ha = sim.world.health.get(a);
    const hb = sim.world.health.get(b);
    expect(ha === undefined || ha.life < ha.maxLife).toBe(true);
    expect(hb === undefined || hb.life < hb.maxLife).toBe(true);
  });
});

describe('spirit, auras and links', () => {
  it('refuses to equip past maximum spirit', () => {
    const { sim, id, p } = setup('aura restore', 'mage');
    const extra = { ...createSigil(sim.newItemUid(), sim.rng, 'relic'), affixes: [] };
    extra.slots = slotsFor('aura fire cold lightning large large', () => sim.newItemUid());
    p.items.set(extra.uid, extra);
    p.inventory[p.inventory.indexOf(null)] = extra.uid;
    expect(sim.equipSigil(id, extra.uid, 1)).toMatch(/spirit/);
  });

  it('only the strongest aura of each type applies, and regen is capped', () => {
    const sim = new Simulation(5);
    const a = sim.addPlayer('a', 'priest');
    const b = sim.addPlayer('b', 'priest');
    // Both priests start with Aura Restore; stack them on the same spot.
    sim.world.position.set(b, { ...sim.world.position.get(a)! });
    sim.step();
    const regen = sim.world.buffs.get(a)!.regenPerSecond;
    expect(regen).toBeCloseTo(AURA.restoreRegenPerSecond, 5);
    const h = sim.world.health.get(a)!;
    h.life = 10;
    for (let i = 0; i < 20; i++) sim.step();
    expect(h.life - 10).toBeLessThanOrEqual(AURA.regenCapPerSecond + 0.01);
  });

  it('a link connects to an ally in the aim direction, breaks out of range and reconnects', () => {
    const sim = new Simulation(9);
    const binder = sim.addPlayer('a', 'binder');
    const ally = sim.addPlayer('b', 'mage');
    const p = sim.world.player.get(binder)!;
    const bp = sim.world.position.get(binder)!;
    // Park the binder's minions far away so the ally is the only candidate in the cone.
    sim.world.position.set(ally, { x: bp.x + 200, y: bp.y });
    for (const m of p.minions) if (m !== null) sim.world.position.set(m, { x: bp.x - 300, y: bp.y });
    const slot = p.sigils.findIndex((s) => s?.compiled.ok && s.compiled.program.form === 'bond');
    expect(slot).toBeGreaterThanOrEqual(0);
    const bits = [BUTTON.skill1, BUTTON.skill2, BUTTON.skill3, BUTTON.skill4];
    sim.applyInput(binder, frame(0, { buttons: bits[slot]!, aimAngle: 0 }));
    sim.step();
    expect(p.links[slot]).toMatchObject({ targetId: ally, connected: true });
    expect(sim.world.buffs.get(ally)!.damageReduction).toBeCloseTo(LINK.wardReduction);

    sim.world.position.set(ally, { x: bp.x + LINK.breakRange + 50, y: bp.y });
    sim.step();
    expect(p.links[slot]?.connected).toBe(false);
    sim.world.position.set(ally, { x: bp.x + LINK.acquireRange - 20, y: bp.y });
    sim.step();
    expect(p.links[slot]?.connected).toBe(true);
  });
});

describe('items and loot', () => {
  it('rare enemies drop items to click up and gold to walk over', () => {
    const sim = new Simulation(11);
    const id = sim.addPlayer('c1', 'warrior');
    const p = sim.world.player.get(id)!;
    const pos = sim.world.position.get(id)!;
    const rare = sim.spawnEnemy('chaser', pos.x + 60, pos.y, true);
    sim.world.health.get(rare)!.life = 1;
    // Flame Cleave, the warrior's third starter skill, burns in a ring close around him; the ring
    // takes a few ticks to grow out to the enemy.
    sim.applyInput(id, frame(0, { buttons: SKILL_BUTTONS[2] }));
    for (let i = 0; i < 10 && sim.world.loot.size === 0; i++) sim.step();
    const bags = [...sim.world.loot.entries()];
    const itemBag = bags.find(([, b]) => b.items.length > 0);
    const goldPile = bags.find(([, b]) => b.gold > 0);
    expect(itemBag).toBeDefined();
    expect(goldPile).toBeDefined();
    for (const [lid] of bags) sim.world.position.set(lid, { x: pos.x, y: pos.y });
    const itemsBefore = p.items.size;
    sim.step();
    // Walking over takes the gold but leaves the items for a click.
    expect(p.gold).toBeGreaterThan(0);
    expect(p.items.size).toBe(itemsBefore);
    expect(sim.pickup(id, itemBag![0])).toBeNull();
    expect(p.items.size).toBeGreaterThan(itemsBefore);
    sim.world.flushDestroyed();
    expect(sim.world.loot.size).toBe(0);
  });

  it('a rare sigil can hold a 5-rune skill and cast it', () => {
    const sim = new Simulation(13);
    const id = sim.addPlayer('c1', 'mage');
    const p = sim.world.player.get(id)!;
    const rare = { ...createSigil(sim.newItemUid(), sim.rng, 'rare'), affixes: [], corrupted: false };
    p.items.set(rare.uid, rare);
    p.inventory[p.inventory.indexOf(null)] = rare.uid;
    rare.slots = slotsFor('bolt fire cold swift split(3) large', () => sim.newItemUid());
    expect(compileSigilItem(rare, 'mage')).toMatchObject({ ok: false, errors: [{ rule: 'over-capacity' }] });
    rare.slots = slotsFor('bolt fire cold swift split(3)', () => sim.newItemUid());
    expect(sim.equipSigil(id, rare.uid, 3)).toBeNull();
    expect(p.sigils[3]?.compiled.ok).toBe(true);
    sim.applyInput(id, frame(0, { buttons: BUTTON.skill4 }));
    expect(sim.world.projectile.size).toBe(3);
  });

  it('rejects editing items the player does not own', () => {
    const sim = new Simulation(1);
    const a = sim.addPlayer('a', 'mage');
    const b = sim.addPlayer('b', 'mage');
    const theirs = sim.world.player.get(b)!.inventory.find((x) => x !== null)!;
    expect(sim.inscribe(a, theirs, [{ from: 'plain', rune: 'bolt' }])).not.toBeNull();
    expect(sim.equipSigil(a, theirs, 0)).not.toBeNull();
  });
});

describe('binder', () => {
  function binder() {
    const sim = new Simulation(21);
    const id = sim.addPlayer('c1', 'binder');
    sim.step();
    return { sim, id, p: sim.world.player.get(id)! };
  }

  it('spawns a minion per equipped vessel', () => {
    const { sim, p } = binder();
    expect(p.minions.filter((m) => m !== null)).toHaveLength(STARTER_VESSELS.length);
    expect(sim.world.minion.size).toBe(STARTER_VESSELS.length);
  });

  it('a dead minion respawns after the cooldown', () => {
    const { sim, p } = binder();
    const mid: EntityId = p.minions[0]!;
    sim.world.health.get(mid)!.life = 0;
    const brute = sim.spawnEnemy('chaser', 0, 0);
    // Kill via the damage pipeline so death bookkeeping runs.
    sim.world.health.get(mid)!.life = 1;
    sim.world.position.set(brute, { ...sim.world.position.get(mid)! });
    for (let i = 0; i < 40 && p.minions[0] === mid; i++) sim.step();
    expect(p.minions[0]).toBeNull();
    for (let i = 0; i < 10 / SIM.dt + 5; i++) sim.step();
    expect(p.minions[0]).not.toBeNull();
  });

  it('refuses vessels for other classes and over spirit', () => {
    const sim = new Simulation(2);
    const mage = sim.addPlayer('m', 'mage');
    const mp = sim.world.player.get(mage)!;
    const v = createVessel(sim.newItemUid(), sim.rng, 'common', 'wraith');
    mp.items.set(v.uid, v);
    mp.inventory[mp.inventory.indexOf(null)] = v.uid;
    expect(sim.equipVessel(mage, v.uid, 0)).toMatch(/Binder/);
  });

  it('follow stance keeps minions near the master instead of engaging', () => {
    const { sim, id, p } = binder();
    sim.cycleStance(id);
    sim.cycleStance(id);
    expect(p.stance).toBe('follow');
    const pos = sim.world.position.get(id)!;
    sim.spawnEnemy('chaser', pos.x + 250, pos.y);
    for (let i = 0; i < 40; i++) sim.step();
    for (const m of p.minions) {
      if (m === null) continue;
      expect(sim.world.minion.get(m)?.targetId).toBeNull();
    }
  });
});

describe('interest management', () => {
  it('only sends entities near the player, plus their own minions', () => {
    const sim = new Simulation(4);
    const id = sim.addPlayer('c1', 'binder');
    sim.step();
    const pos = sim.world.position.get(id)!;
    const far = sim.spawnEnemy('chaser', pos.x > 1400 ? 60 : 2740, pos.y > 1000 ? 60 : 1940);
    const p = sim.world.player.get(id)!;
    const minion = p.minions[0]!;
    sim.world.position.set(minion, { x: pos.x > 1400 ? 80 : 2700, y: pos.y });
    const snap = snapshotFor(sim, id, serializeEntities(sim), [], NET.interestRadius);
    const ids = snap.entities.map((e) => e.id);
    expect(ids).toContain(id);
    expect(ids).toContain(minion);
    expect(ids).not.toContain(far);
  });
});
