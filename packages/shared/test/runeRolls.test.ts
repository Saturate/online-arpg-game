import { describe, expect, it } from 'vitest';
import { addItem, discard } from '../src/sim/inventory.js';
import {
  AFFIXES,
  clampRoll,
  clampRuneRolls,
  convertCharacterSave,
  createGear,
  createRune,
  createSigil,
  createStarterSigil,
  isInscribeReply,
  isServerMessage,
  matchingStarter,
  pendingItems,
  rollLosses,
  Simulation,
  starterSigilById,
  STARTER_SIGILS,
  type AffixRoll,
  type PlayerComp,
  type RuneItem,
  type RuneRef,
  type SigilItem,
} from '../src/index.js';

function town() {
  const sim = new Simulation(4, { kind: 'zone', zone: 'barrens', seed: 3 });
  const pid = sim.addPlayer('c', 'mage');
  const p = sim.world.player.get(pid);
  const pos = sim.world.position.get(pid);
  const forge = sim.mapDef.forge;
  if (!p || !pos || !forge) throw new Error('setup');
  pos.x = forge.x + 50;
  pos.y = forge.y;
  return { sim, pid, p };
}

function rolled(affixes: AffixRoll[]): RuneItem {
  return { ...createRune(1, 'orb'), affixes };
}

function best(id: AffixRoll['id'], side: 'max' | 'min'): number {
  const live = AFFIXES[id].tiers.filter((t) => t.weight > 0);
  return side === 'max' ? Math.max(...live.map((t) => t.max)) : Math.min(...live.map((t) => t.min));
}

function starter(sim: Simulation, id: string, bound: boolean): SigilItem {
  const def = starterSigilById(id);
  if (!def) throw new Error(`no starter ${id}`);
  return createStarterSigil(() => sim.newItemUid(), def, { bound });
}

function fillBag(sim: Simulation, p: PlayerComp): void {
  while (addItem(p, createGear(sim.newItemUid(), sim.rand.loot, 'common', 1, { category: 'ring' })));
}

describe('rolls past the loot table', () => {
  it('clamp a higher-is-better roll down to the best any tier rolls', () => {
    const top = best('rune_damage', 'max');
    expect(clampRoll({ id: 'rune_damage', tier: 0, value: 100 })).toEqual({ id: 'rune_damage', tier: AFFIXES.rune_damage.tiers.length - 1, value: top });
    const inside: AffixRoll = { id: 'rune_damage', tier: 1, value: 25 };
    expect(clampRoll(inside)).toBe(inside);
    // Weaker than any drop (a slow starter orb) is left as it is.
    const slow: AffixRoll = { id: 'rune_speed', tier: 0, value: -35 };
    expect(clampRoll(slow)).toBe(slow);
  });

  it('clamp a faster pulse up to the fastest a drop can have', () => {
    expect(clampRoll({ id: 'release_every', tier: 0, value: 0.18 }).value).toBe(best('release_every', 'min'));
    const slower: AffixRoll = { id: 'release_every', tier: 0, value: 0.9 };
    expect(clampRoll(slower)).toBe(slower);
  });

  it('bring a fuse time outside the table to its nearest edge, either way', () => {
    expect(clampRoll({ id: 'release_after', tier: 0, value: 0.05 }).value).toBe(best('release_after', 'min'));
    expect(clampRoll({ id: 'release_after', tier: 0, value: 9 }).value).toBe(best('release_after', 'max'));
  });

  it('leave a rune untouched, same object, when nothing is past the table, and list what changes otherwise', () => {
    const fine = rolled([{ id: 'rune_size', tier: 0, value: 15 }]);
    expect(clampRuneRolls(fine)).toBe(fine);
    expect(rollLosses(fine)).toEqual([]);
    const strong = rolled([
      { id: 'rune_damage', tier: 0, value: 100 },
      { id: 'rune_speed', tier: 0, value: -15 },
    ]);
    const out = clampRuneRolls(strong);
    expect(out).not.toBe(strong);
    expect(out.uid).toBe(strong.uid);
    expect(out.affixes.map((a) => a.value)).toEqual([best('rune_damage', 'max'), -15]);
    expect(strong.affixes[0]?.value).toBe(100);
    expect(rollLosses(strong).map((l) => [l.before.value, l.after.value])).toEqual([[100, best('rune_damage', 'max')]]);
  });

  it('some starter rune is past the table, so the rule is not idle', () => {
    let uid = 1;
    const past = STARTER_SIGILS.flatMap((def) => createStarterSigil(() => uid++, def, { bound: false }).slots.flatMap(rollLosses));
    expect(past.length).toBeGreaterThan(0);
  });
});

describe('taking a rune out of a sigil', () => {
  it('clamps its rolls at the forge, for an unbound dropped starter; putting it back keeps the clamped rolls', () => {
    const { sim, pid, p } = town();
    // Find a starter with a rune past the table, whatever the current balance pass made them.
    const def = STARTER_SIGILS.find((d) => starter(sim, d.id, false).slots.some((r) => rollLosses(r).length > 0));
    if (!def) throw new Error('no starter past the table');
    const s = starter(sim, def.id, false);
    addItem(p, s);
    const index = s.slots.findIndex((r) => rollLosses(r).length > 0);
    const out = s.slots[index];
    if (!out) throw new Error('setup');
    const expected = clampRuneRolls(out).affixes;
    const keep: RuneRef[] = s.slots.flatMap((_, i): RuneRef[] => (i === index ? [] : [{ from: 'keep', index: i }]));
    expect(sim.inscribe(pid, s.uid, keep)).toBeNull();
    const back = p.items.get(out.uid);
    if (back?.kind !== 'rune') throw new Error('rune not back');
    expect(back.affixes).toEqual(expected);
    expect(back.bound).toBeUndefined();
    p.gold = 10_000;
    const kept = s.slots.map((_, i): RuneRef => ({ from: 'keep', index: i }));
    expect(sim.inscribe(pid, s.uid, [...kept, { from: 'rolled', uid: out.uid }])).toBeNull();
    expect(s.slots.at(-1)?.affixes).toEqual(expected);
  });

  it('clamps bound starter runes too, and keeps rolls while runes only move inside the sigil', () => {
    const { sim, pid, p } = town();
    const s = starter(sim, 'fireball', true);
    addItem(p, s);
    const rolls = JSON.stringify(s.slots.map((r) => r.affixes));
    const reversed: RuneRef[] = s.slots.map((_, i): RuneRef => ({ from: 'keep', index: s.slots.length - 1 - i }));
    expect(sim.inscribe(pid, s.uid, reversed)).toBeNull();
    expect(JSON.stringify([...s.slots].reverse().map((r) => r.affixes))).toBe(rolls);
    const orb = s.slots.find((r) => r.rune === 'orb');
    if (!orb) throw new Error('fireball has no orb');
    const needsClamp = rollLosses(orb).length > 0;
    expect(sim.inscribe(pid, s.uid, [])).toBeNull();
    const back = p.items.get(orb.uid);
    if (back?.kind !== 'rune') throw new Error('orb not back');
    expect(back.bound).toBe(true);
    expect(rollLosses(back)).toEqual([]);
    if (needsClamp) expect(back.affixes).not.toEqual(orb.affixes);
  });
});

describe("builders' bench", () => {
  function bench() {
    const sim = new Simulation(5);
    const pid = sim.addPlayer('b', 'mage');
    const p = sim.world.player.get(pid);
    if (!p) throw new Error('setup');
    return { sim, pid, p };
  }

  it("hands back a builder's real bound starter runes", () => {
    const { sim, pid, p } = bench();
    const s = starter(sim, 'static_nova', true);
    addItem(p, s);
    const uids = s.slots.map((r) => r.uid);
    expect(sim.inscribe(pid, s.uid, [{ from: 'plain', rune: 'orb' }], true)).toBeNull();
    for (const u of uids) expect(p.items.get(u)?.bound).toBe(true);
    expect(s.slots.map((r) => r.bench)).toEqual([true]);
  });

  it('drops bench runes when they leave a sigil at a real forge, and hands back the rest', () => {
    const { sim, pid, p } = bench();
    const s = createSigil(sim.newItemUid(), sim.rand.loot, 'rare');
    addItem(p, s);
    expect(sim.inscribe(pid, s.uid, [{ from: 'plain', rune: 'orb' }, { from: 'plain', rune: 'fire' }], true)).toBeNull();
    const [orb, fire] = s.slots;
    if (!orb || !fire) throw new Error('setup');
    // Carried off the bench into a real town.
    const town2 = town();
    const copy = { ...s, uid: town2.sim.newItemUid(), slots: s.slots.map((r) => ({ ...r, uid: town2.sim.newItemUid() })) };
    const cold = createRune(town2.sim.newItemUid(), 'cold', 1);
    copy.slots.push(cold);
    addItem(town2.p, copy);
    town2.p.gold = 0;
    expect(town2.sim.inscribe(town2.pid, copy.uid, [])).toBeNull();
    const runes = [...town2.p.items.values()].filter((i): i is RuneItem => i.kind === 'rune');
    expect(runes.map((r) => r.rune)).toEqual(['cold']);
    expect(runes.some((r) => r.bench === true)).toBe(false);
  });
});

describe('pending items', () => {
  it('top up matching stacks before taking a cell, and move in once the bag has room', () => {
    const { sim, pid, p } = town();
    const stack = createRune(sim.newItemUid(), 'fire', 18);
    addItem(p, stack);
    const s = createSigil(sim.newItemUid(), sim.rand.loot, 'rare');
    s.slots = [createRune(sim.newItemUid(), 'fire', 1), createRune(sim.newItemUid(), 'fire', 1), createRune(sim.newItemUid(), 'fire', 1)];
    addItem(p, s);
    fillBag(sim, p);
    expect(pendingItems(p)).toEqual([]);
    expect(sim.inscribe(pid, s.uid, [])).toBeNull();
    // Two top the stack up to 20; the third finds no room and waits.
    expect(stack.count).toBe(20);
    const waiting = pendingItems(p);
    expect(waiting).toHaveLength(1);
    const ring = p.inventory.find((u) => u !== null && p.items.get(u)?.kind === 'gear');
    if (ring === undefined || ring === null) throw new Error('no ring');
    expect(discard(sim, pid, ring)).toBeNull();
    expect(pendingItems(p)).toEqual([]);
    expect(p.inventory.includes(waiting[0] ?? -1)).toBe(true);
  });
});

describe('starter identity', () => {
  it('holds only while the slots are the starter runes in order', () => {
    const { sim } = town();
    const s = starter(sim, 'war_cry', false);
    expect(matchingStarter(s)?.id).toBe('war_cry');
    const renamed = { ...s, name: 'Viper Veil' };
    expect(matchingStarter(renamed)?.name).toBe('War Cry');
    expect(matchingStarter({ ...s, slots: [...s.slots].reverse() })).toBeUndefined();
    expect(matchingStarter({ ...s, slots: s.slots.slice(1) })).toBeUndefined();
    const { starter: _dropped, ...plain } = s;
    expect(matchingStarter(plain)).toBeUndefined();
  });
});

describe('inscribe reply', () => {
  it('validates both shapes and rejects anything else', () => {
    expect(isInscribeReply({ t: 'inscribed', uid: 4, ok: true })).toBe(true);
    expect(isInscribeReply({ t: 'inscribed', uid: 4, ok: false, error: 'That costs 12 gold' })).toBe(true);
    expect(isInscribeReply({ t: 'inscribed', uid: 4, ok: false })).toBe(false);
    expect(isInscribeReply({ t: 'inscribed', uid: -1, ok: true })).toBe(false);
    expect(isInscribeReply({ t: 'inscribed', uid: 4, ok: 'yes' })).toBe(false);
    expect(isServerMessage({ t: 'inscribed', uid: 4, ok: true })).toBe(true);
    expect(isServerMessage({ t: 'inscribed', uid: 'x', ok: true })).toBe(false);
  });
});

describe('conversion report', () => {
  it('records the v1 runes a built-in skill sigil held, which starter runes replace for no gold', () => {
    const raw = {
      classId: 'mage',
      name: 'Old',
      items: [{ uid: 1, kind: 'sigil', tier: 'common', name: 'Fireball', ilvl: 1, affixes: [], runes: ['bolt', 'fire', 'linger', 'onhit', 'nova'], skill: 'fireball', corrupted: false, bound: true }],
      inventory: [],
      stash: [],
      sigils: [1, null, null, null],
      warband: [null, null, null, null],
      gear: { weapon: null, helmet: null, body: null, gloves: null, boots: null, belt: null, amulet: null, ring1: null, ring2: null },
      stance: 'defensive',
      waypoints: [],
      level: 1,
      xp: 0,
      gold: 5,
    };
    const { save, report } = convertCharacterSave(raw);
    expect(report.runesReplaced).toEqual([
      { from: 'bolt', count: 1 },
      { from: 'fire', count: 1 },
      { from: 'linger', count: 1 },
      { from: 'onhit', count: 1 },
      { from: 'nova', count: 1 },
    ]);
    expect(report.runesRefunded).toEqual([]);
    expect(save.gold).toBe(5);
  });
});
