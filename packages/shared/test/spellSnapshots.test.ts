import { describe, expect, it } from 'vitest';
import { advanceSpell, NET, serializeEntities, SKILL_BUTTONS, snapshotFor, Simulation, type EntityId, type EntitySnap, type SpellSnap } from '../src/index.js';

/** Mirrors the client's SpellTable: records carried forward, dropped when gone. */
function expand(records: Map<EntityId, { record: SpellSnap; tick: number }>, spells: readonly SpellSnap[], gone: readonly EntityId[], tick: number): EntitySnap[] {
  for (const id of gone) records.delete(id);
  for (const record of spells) records.set(record.id, { record, tick });
  return [...records.values()].map(({ record, tick: at }) => advanceSpell(record, tick - at));
}

describe('spell entities sent once', () => {
  it('the client rebuilds every tick\'s spells from records sent once', () => {
    const sim = new Simulation(9);
    const pid = sim.addPlayer('m', 'mage');
    const known = new Map<EntityId, string>();
    const records = new Map<EntityId, { record: SpellSnap; tick: number }>();
    let seq = 0;
    let sentRecords = 0;
    let spellTicks = 0;
    let entityTicks = 0;
    for (let t = 0; t < 200; t++) {
      // Alternate Fireball and Frozen Orb so bolts, novas, zones and shards all appear.
      const bit = SKILL_BUTTONS[t % 40 < 20 ? 0 : 1] ?? 0;
      sim.applyInput(pid, { seq: ++seq, moveDir: { x: 0, y: 0 }, aimAngle: 0.3, buttons: t % 3 === 0 ? bit : 0 });
      sim.step();
      const all = serializeEntities(sim);
      const snap = snapshotFor(sim, pid, all, [], NET.interestRadius, known);
      sentRecords += snap.spells.length;
      const rebuilt = new Map(expand(records, snap.spells, snap.gone, snap.tick).map((e) => [e.id, e]));
      const truth = snapshotFor(sim, pid, all, [], NET.interestRadius).entities.filter((e) => e.k === 'projectile' || e.k === 'nova' || e.k === 'zone');
      if (truth.length > 0) spellTicks++;
      entityTicks += truth.length;
      expect([...rebuilt.keys()].sort()).toEqual(truth.map((e) => e.id).sort());
      for (const e of truth) {
        const r = rebuilt.get(e.id);
        if (!r) throw new Error(`missing ${e.id}`);
        expect(Math.hypot(r.x - e.x, r.y - e.y)).toBeLessThan(1);
        expect(Math.abs(r.r - e.r)).toBeLessThan(1);
        if (e.k === 'zone' && r.k === 'zone') expect(Math.abs(r.left - e.left)).toBeLessThan(0.02);
      }
    }
    expect(spellTicks).toBeGreaterThan(50);
    // Each spell entity is sent about once instead of every tick it lives.
    expect(sentRecords * 5).toBeLessThan(entityTicks);
  });
});
