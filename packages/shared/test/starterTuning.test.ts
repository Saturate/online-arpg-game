import { afterEach, describe, expect, it } from 'vitest';
import {
  applyTunables,
  castingSlots,
  castingStarter,
  clampRuneRolls,
  compileSigilItem,
  convertRuneRolls,
  createRune,
  createStarterSigil,
  holdsStarterRecipe,
  liveStarterRunes,
  oldStarterRunes,
  recompileSigils,
  resetTunables,
  runeItemFromInstance,
  shownSlots,
  SKILL_BUTTONS,
  Simulation,
  STARTER_SIGILS,
  starterSigilById,
  TUNABLES,
  tunableValue,
  starterTuningProblem,
  sellPrice,
  buyPrice,
  forgeInsertPrice,
  type Item,
  type RuneItem,
  tunableSpec,
  tokenizeSpell,
  toRuneInstance,
  type EntityId,
  type SigilItem,
  type StarterSigilDef,
} from '../src/index.js';
import { addItem, compileSigil } from '../src/sim/inventory.js';

afterEach(() => resetTunables());

function starter(id: string): StarterSigilDef {
  const def = starterSigilById(id);
  if (!def) throw new Error(`no starter ${id}`);
  return def;
}

function made(id: string): SigilItem {
  let uid = 100;
  return createStarterSigil(() => uid++, starter(id), { bound: false });
}

/** A plain (no starter) common sigil holding `text`, rune for rune with its rolls. */
function playerMade(text: string): SigilItem {
  let uid = 500;
  const slots = tokenizeSpell(text).runes.map((r) => runeItemFromInstance(uid++, r, false));
  return { uid: 499, kind: 'sigil', tier: 'common', name: 'Common Sigil', ilvl: 1, affixes: [], slots, corrupted: false };
}

function casts(item: SigilItem): string {
  return JSON.stringify(castingSlots(item).map(toRuneInstance));
}

describe('starter numbers in the registry', () => {
  it('lists every roll of every starter recipe under Starters, grouped by starter, at its code default', () => {
    const paths = new Set(TUNABLES.filter((t) => t.category === 'starters').map((t) => t.path));
    let expected = 0;
    for (const def of STARTER_SIGILS) {
      def.runes.forEach((rune, i) => {
        for (const [key, v] of Object.entries(rune.affixes)) {
          if (key === 'release') {
            const r = rune.affixes.release;
            if (!r || (r.kind !== 'after' && r.kind !== 'every')) continue;
            const spec = tunableSpec(`starter.${def.id}.${i}.${r.kind}`);
            expect(spec?.default, `${def.id} rune ${i} ${r.kind}`).toBe(r.seconds);
            expect(spec?.group).toBe(def.name);
            expected++;
            continue;
          }
          const spec = tunableSpec(`starter.${def.id}.${i}.${key}`);
          expect(spec?.default, `${def.id} rune ${i} ${key}`).toBe(v);
          expect(spec?.category).toBe('starters');
          expect(spec?.group).toBe(def.name);
          expected++;
        }
      });
    }
    expect(paths.size).toBe(expected);
    expect(tunableSpec('starter.bone_spear.0.damage')).toMatchObject({ default: 40, min: -90, max: 400, int: false });
    expect(tunableSpec('starter.bone_spear.0.pierce')).toMatchObject({ default: 4, min: 0, max: 40, int: true });
    expect(tunableSpec('starter.multishot.1.count')).toMatchObject({ default: 5, min: 2, max: 6, int: true });
    expect(tunableSpec('starter.frozen_orb.0.every')).toMatchObject({ default: 0.18, min: 0.1 });
  });

  it('leaves every starter casting its stored rolls exactly at the code defaults', () => {
    for (const def of STARTER_SIGILS) {
      const s = made(def.id);
      expect(holdsStarterRecipe(s), def.id).toBe(true);
      expect(castingSlots(s)).toEqual(s.slots);
      expect(liveStarterRunes(def)).toEqual(def.runes);
    }
  });

  it('keeps every starter compiling, and fast, at the ends of its ranges and the shapes\'', () => {
    for (const ends of ['min', 'max'] as const) {
      applyTunables(Object.fromEntries(TUNABLES.filter((t) => t.category === 'starters' || t.category === 'shapes').map((t) => [t.path, t[ends]])));
      for (const def of STARTER_SIGILS) {
        const started = Date.now();
        const c = compileSigilItem(made(def.id), def.classId);
        expect(c.ok, `${def.id} at ${ends}`).toBe(true);
        expect(Date.now() - started).toBeLessThan(15);
      }
    }
  });
});

describe('a whole starter casts the live recipe', () => {
  it('reaches every copy of Bone Spear without touching its stored rolls, and never clamps it', () => {
    const s = made('bone_spear');
    const stored = JSON.stringify(s.slots);
    applyTunables({ 'starter.bone_spear.0.damage': 400, 'starter.bone_spear.0.pierce': 9 });
    const [bolt] = castingSlots(s);
    expect(bolt && toRuneInstance(bolt).affixes).toMatchObject({ damage: 400, pierce: 9, speed: 50 });
    expect(JSON.stringify(s.slots)).toBe(stored);
    expect(shownSlots(s)[0]?.affixes.find((a) => a.id === 'rune_damage')?.value).toBe(400);
    // What comes out of the sigil is the stored roll clamped, as before.
    const out = s.slots[0] ? clampRuneRolls(s.slots[0]) : null;
    expect(out?.affixes.find((a) => a.id === 'rune_damage')?.value).toBe(40);
    const c = compileSigilItem(s, 'binder');
    if (!c.ok) throw new Error('Bone Spear does not compile');
    expect(c.notes.some((n) => n.startsWith('Starter rolls only hold'))).toBe(false);
  });

  it('casts the recipe for a copy made with other values in the same tiers, such as one from before a retune', () => {
    const s = made('bone_spear');
    const [bolt] = s.slots;
    if (!bolt) throw new Error('no bolt');
    const old: SigilItem = { ...s, slots: [{ ...bolt, affixes: bolt.affixes.map((a) => (a.id === 'rune_damage' ? { ...a, value: 52 } : a)) }] };
    expect(holdsStarterRecipe(old)).toBe(true);
    expect(casts(old)).toBe(casts(s));
  });

  it('casts a starter emptied and refilled with plain runes clamped, so the refill is not free', () => {
    for (const def of STARTER_SIGILS) {
      const s = made(def.id);
      if (s.slots.every((r) => r.affixes.length === 0)) continue;
      let uid = 900;
      const refilled: SigilItem = { ...s, slots: s.slots.map((r) => createRune(uid++, r.rune)) };
      expect(holdsStarterRecipe(refilled), def.id).toBe(false);
      expect(castingSlots(refilled)).toEqual(refilled.slots);
    }
    applyTunables({ 'starter.bone_spear.0.damage': 400 });
    const spear = made('bone_spear');
    const plain: SigilItem = { ...spear, slots: [createRune(950, 'bolt')] };
    expect(casts(plain)).not.toContain('400');
  });

  it('casts the recipe for a refill with a found rune of the same affix kinds at the recipe roll tiers, and only then', () => {
    const s = made('bone_spear');
    // A top-tier drop Bolt: pierce 3, speed and damage in their T3 ranges, as Bone Spear's rolls are.
    const found = runeItemFromInstance(960, { id: 'bolt', affixes: { pierce: 3, speed: 40, damage: 45 } }, false);
    expect(holdsStarterRecipe({ ...s, slots: [found] })).toBe(true);
    expect(casts({ ...s, slots: [found] })).toBe(casts(s));
    // One roll a tier lower, or one affix kind short, is not the recipe.
    const lower = runeItemFromInstance(961, { id: 'bolt', affixes: { pierce: 3, speed: 30, damage: 45 } }, false);
    const short = runeItemFromInstance(962, { id: 'bolt', affixes: { pierce: 3, damage: 45 } }, false);
    for (const r of [lower, short]) {
      expect(holdsStarterRecipe({ ...s, slots: [r] })).toBe(false);
      expect(castingStarter({ ...s, slots: [r] })).toBeUndefined();
    }
  });

  it('casts bench runes as what they are, even in their starter', () => {
    const s = made('bone_spear');
    const bench: SigilItem = { ...s, slots: [{ ...createRune(901, 'bolt'), bound: true, bench: true }] };
    expect(holdsStarterRecipe(bench)).toBe(false);
    expect(castingSlots(bench)[0]?.affixes).toEqual([]);
  });

  it('leaves a changed Bone Spear and a player-made bolt with the same rolls clamped and untouched by a tweak', () => {
    const s = made('bone_spear');
    const appended: SigilItem = { ...s, slots: [...s.slots, createRune(902, 'lightning')] };
    const own = playerMade('bolt[pierce 4, +50% speed, +40% damage]');
    const notStarter: SigilItem = { ...s, starter: 'smite' };
    const before = [appended, own, notStarter].map(casts);
    for (const item of [appended, own, notStarter]) expect(holdsStarterRecipe(item)).toBe(false);
    applyTunables({ 'starter.bone_spear.0.damage': 400 });
    expect([appended, own, notStarter].map(casts)).toEqual(before);
    // Clamped into the loot table, not the starter's +40%.
    expect(castingSlots(own)[0]?.affixes.find((a) => a.id === 'rune_pierce')?.value).toBe(3);
  });

  it('changes the next Bone Spear cast in a running room after recompileSigils, and only that sigil', () => {
    const sim = new Simulation(11, { kind: 'flat' });
    sim.waveTimer = Infinity;
    const pid: EntityId = sim.addPlayer('tuner', 'binder');
    const p = sim.world.player.get(pid);
    if (!p) throw new Error('no player');
    p.god = true;
    p.warband = p.warband.map(() => null);
    const spear = made('bone_spear');
    const own = playerMade('bolt[pierce 3, +40% damage]');
    for (const item of [spear, own]) p.items.set(item.uid, item);
    p.sigils = [compileSigil(p, spear), compileSigil(p, own), null, null];
    let seq = 0;
    const damageOf = (slot: number): number => {
      while (p.castCooldown > 0) sim.step();
      p.heat = 0;
      const before = new Set(sim.world.projectile.keys());
      sim.applyInput(pid, { seq: ++seq, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: SKILL_BUTTONS[slot] ?? 0 });
      sim.step();
      sim.applyInput(pid, { seq: ++seq, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: 0 });
      for (const [id, proj] of sim.world.projectile) if (proj.ownerId === pid && !before.has(id)) return proj.damage;
      throw new Error(`slot ${slot} cast nothing`);
    };
    const spearBefore = damageOf(0);
    const ownBefore = damageOf(1);
    applyTunables({ 'starter.bone_spear.0.damage': 140 });
    recompileSigils(sim);
    expect(damageOf(0)).toBeCloseTo((spearBefore * 2.4) / 1.4, 5);
    expect(damageOf(1)).toBeCloseTo(ownBefore, 5);
  });
});

describe('old starter recipes', () => {
  it('still convert, and the rebuilt sigil casts the live recipe', () => {
    applyTunables({ 'starter.multishot.0.damage': 250 });
    for (const id of ['multishot', 'flame_cleave']) {
      const def = starter(id);
      const old = oldStarterRunes(id);
      if (!old) throw new Error(`no old recipe for ${id}`);
      let uid = 1;
      const sigil: SigilItem = { ...made(id), slots: old.map((r) => runeItemFromInstance(uid++, r, true)) };
      expect(holdsStarterRecipe(sigil), id).toBe(false);
      const [after] = convertRuneRolls([sigil]).items;
      if (after?.kind !== 'sigil') throw new Error('not a sigil');
      expect(holdsStarterRecipe(after)).toBe(true);
      // Stored at the code default, cast at the live number.
      expect(JSON.stringify(after.slots.map(toRuneInstance))).toBe(JSON.stringify(def.runes));
      expect(JSON.stringify(castingSlots(after).map(toRuneInstance))).toBe(JSON.stringify(liveStarterRunes(def)));
    }
  });
});

/** A binder at the forge holding `items` in the bag. */
function atForge(...items: Item[]) {
  const sim = new Simulation(4, { kind: 'world', seed: 3 });
  const pid = sim.addPlayer('smith', 'binder');
  const p = sim.world.player.get(pid);
  const pos = sim.world.position.get(pid);
  const forge = sim.mapDef.forge;
  if (!p || !pos || !forge) throw new Error('setup');
  pos.x = forge.x + 50;
  pos.y = forge.y;
  p.gold = 10_000;
  for (const it of items) addItem(p, it);
  return { sim, pid, p };
}

function sigilIn(p: { items: Map<number, Item> }, uid: number): SigilItem {
  const it = p.items.get(uid);
  if (it?.kind !== 'sigil') throw new Error('no sigil');
  return it;
}

function looseRunes(p: { items: Map<number, Item> }, rune: string): RuneItem[] {
  return [...p.items.values()].filter((i): i is RuneItem => i.kind === 'rune' && i.rune === rune);
}

describe('the forge and the starter rule', () => {
  it('a Static Nova swapped for a cheap Nova at the forge casts clamped, and a top-tier one casts the recipe', () => {
    const nova = made('static_nova');
    const cheap = runeItemFromInstance(700, { id: 'nova', affixes: { size: 10 } }, false);
    const good = runeItemFromInstance(701, { id: 'nova', affixes: { size: 40 } }, false);
    const { sim, pid, p } = atForge(nova, cheap, good);
    expect(sim.inscribe(pid, nova.uid, [{ from: 'rolled', uid: cheap.uid }, { from: 'keep', index: 1 }])).toBeNull();
    const swapped = sigilIn(p, nova.uid);
    // The starter's +50% Nova came back whole; the sigil now casts the +10% it holds, not the recipe.
    expect(looseRunes(p, 'nova').some((r) => r.affixes.some((a) => a.id === 'rune_size' && a.value === 50))).toBe(true);
    expect(holdsStarterRecipe(swapped)).toBe(false);
    expect(castingStarter(swapped)).toBeUndefined();
    expect(castingSlots(swapped)[0]?.affixes.find((a) => a.id === 'rune_size')?.value).toBe(10);
    expect(sim.inscribe(pid, nova.uid, [{ from: 'rolled', uid: good.uid }, { from: 'keep', index: 1 }])).toBeNull();
    const restored = sigilIn(p, nova.uid);
    expect(holdsStarterRecipe(restored)).toBe(true);
    expect(castingSlots(restored)[0]?.affixes.find((a) => a.id === 'rune_size')?.value).toBe(50);
  });

  it('a tuned starter extracted at the forge gives back its stored rolls clamped, not the live numbers', () => {
    const spear = made('bone_spear');
    const { sim, pid, p } = atForge(spear);
    applyTunables({ 'starter.bone_spear.0.damage': 400, 'starter.bone_spear.0.pierce': 9 });
    expect(sim.inscribe(pid, spear.uid, [])).toBeNull();
    const [out] = looseRunes(p, 'bolt');
    expect(out?.affixes.find((a) => a.id === 'rune_damage')?.value).toBe(40);
    expect(out?.affixes.find((a) => a.id === 'rune_pierce')?.value).toBe(3);
  });

  it('prices a starter sigil and its runes the same whatever the tuning', () => {
    const items = STARTER_SIGILS.map((d) => made(d.id));
    const plain = items.map((s) => [sellPrice(s), buyPrice(s), ...s.slots.map((r) => forgeInsertPrice(r))]);
    applyTunables(Object.fromEntries(TUNABLES.filter((t) => t.category === 'starters').map((t) => [t.path, t.max])));
    expect(items.map((s) => [sellPrice(s), buyPrice(s), ...s.slots.map((r) => forgeInsertPrice(r))])).toEqual(plain);
  });
});

describe('refusing tuning that breaks a starter', () => {
  it('names Frozen Orb for a faster pulse with more shards, and checks every min and max combination of each starter', () => {
    expect(starterTuningProblem({ 'starter.frozen_orb.0.every': 0.14, 'starter.frozen_orb.2.count': 5 })).toMatch(/^Frozen Orb would not compile: /);
    expect(starterTuningProblem({ 'starter.frozen_orb.0.every': 0.3 })).toBeNull();
    let combos = 0;
    let refused = 0;
    for (const def of STARTER_SIGILS) {
      const specs = TUNABLES.filter((t) => t.group === def.name);
      for (let mask = 0; mask < 2 ** specs.length; mask++) {
        const values = Object.fromEntries(specs.map((t, i) => [t.path, mask & (1 << i) ? t.max : t.min]));
        combos++;
        const problem = starterTuningProblem(values);
        applyTunables(values);
        const ok = compileSigilItem(made(def.id), def.classId).ok;
        resetTunables();
        expect(problem === null, `${def.id} ${JSON.stringify(values)}`).toBe(ok);
        if (problem !== null) {
          refused++;
          expect(problem.startsWith(`${def.name} would not compile`)).toBe(true);
        }
      }
    }
    expect(combos).toBe(125);
    expect(refused).toBeGreaterThan(0);
    // The overrides in force are put back after the check.
    applyTunables({ 'starter.bone_spear.0.damage': 60 });
    starterTuningProblem({ 'starter.frozen_orb.0.every': 0.14, 'starter.frozen_orb.2.count': 5 });
    expect(tunableValue('starter.bone_spear.0.damage')).toBe(60);
    expect(tunableValue('starter.frozen_orb.0.every')).toBe(0.18);
  });
});
