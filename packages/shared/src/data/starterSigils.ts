import { runeItemFromInstance, type ItemUid, type SigilItem } from '../items/items.js';
import { tokenizeSpell } from '../runes/v2/tokenize.js';
import type { RuneInstance } from '../runes/v2/runes.js';
import type { ClassId } from './classes.js';

/**
 * The built-in skills as starter sigils: common sigils holding pre-rolled runes, so their numbers
 * are readable, copyable and improvable like any hand-built spell. The rune lists reproduce the v1
 * hand tuning where the grammar can express it; where it cannot, the entry says so.
 *
 * Numbers are relative to each shape's base (SPELL in config/sim.ts). An Orb flies at 0.55 of a
 * Bolt's speed with twice its size and 1.3x its range, and rolls through enemies unless it bursts on
 * hit, so an orb's affixes are the old bolt tuning divided by that.
 *
 * Every entry is held to its v1 Force and damage by test/skillParity.test.ts.
 */
export interface StarterSigilDef {
  id: string;
  name: string;
  description: string;
  classId: ClassId;
  runes: RuneInstance[];
}

/** Written in the text form the Spell Lab reads; a typo fails loudly at load, not silently in play. */
function spell(text: string): RuneInstance[] {
  const t = tokenizeSpell(text);
  if (t.errors.length > 0) throw new Error(`starter sigil "${text}": ${t.errors.map((e) => e.message).join('; ')}`);
  return t.runes;
}

export const STARTER_SIGILS: readonly StarterSigilDef[] = [
  // Mage
  {
    id: 'fireball',
    name: 'Fireball',
    description: 'Explodes on impact and leaves the ground burning.',
    classId: 'mage',
    // The Fireball of docs/features/runes.md, not a copy of v1 (a bolt at 0.85 speed and 2x damage). The orb
    // carries v1's 2x hit, since the burst and the burning ground only add to it. v1 had Linger
    // (+75% duration), but one caster's zones never stack and it recasts long before the ground
    // goes out, so the extra time added no damage while its payload price pushed Force past v1.
    runes: spell('orb[onhit, -15% speed, +100% damage] fire nova[after 0.5s] zone[+30% duration]'),
  },
  {
    id: 'frozen_orb',
    name: 'Frozen Orb',
    description: 'A slow orb that sprays ice shards in every direction as it travels.',
    classId: 'mage',
    // v1: speed 0.36, range 0.85, radius 2.2, damage 0.6 on a bolt that passed through everything,
    // which an orb does by itself. v1 also let it exceed the entity cap (48); the grammar's live cap
    // is 40 and it peaks under that. Its shards go off 14 times a cast and pay for each release, but
    // a ring of three faces any one target with little of it, so they add about 3 Force.
    runes: spell('orb[every 0.18s, -35% speed, -35% duration, +10% size, -40% damage] cold split(3) bolt'),
  },
  { id: 'static_nova', name: 'Static Nova', description: 'A wide ring of lightning that shocks everything it touches.', classId: 'mage', runes: spell('nova[+50% size] lightning') },
  // v1: two Swift runes, 1.3x dash distance each.
  { id: 'blink', name: 'Blink', description: 'A long, fast dash.', classId: 'mage', runes: spell('dash[+69% speed]') },
  // Warrior
  {
    id: 'leap_slam',
    name: 'Leap Slam',
    description: 'Leap forward and slam the ground, knocking enemies back.',
    classId: 'warrior',
    // v1 set its Force by hand to 22; the formula prices it now.
    runes: spell('dash[onland] impact nova[+50% size]'),
  },
  { id: 'war_cry', name: 'War Cry', description: 'A shockwave that hurls enemies away.', classId: 'warrior', runes: spell('nova[+50% size] impact') },
  // The owner's buff (2026-10-01): v1's three short fire waves dealt about 13 damage a cast. A small
  // burning ring at the v1 price reads as a cleave around the warrior. Sigils that still hold the old
  // waves are rebuilt on load (items/convertRuneRolls.ts, OLD_STARTER_RUNES).
  { id: 'flame_cleave', name: 'Flame Cleave', description: 'A ring of fire that burns everything close around you.', classId: 'warrior', runes: spell('nova[-40% size, +50% damage] fire') },
  { id: 'iron_skin', name: 'Iron Skin', description: 'Aura: you and nearby allies take less damage.', classId: 'warrior', runes: spell('aura ward') },
  // Ranger
  // The owner's buff (2026-10-01): v1's nine arrows dealt about 4 damage a cast. Five arrows, each
  // with split's 1.2 / 5 share of a +300% hit, at about the v1 price. Sigils that still hold the old
  // nine are rebuilt on load (items/convertRuneRolls.ts, OLD_STARTER_RUNES).
  { id: 'multishot', name: 'Multishot', description: 'A wide fan of piercing arrows.', classId: 'ranger', runes: spell('bolt[pierce 2, +300% damage] split(5)') },
  // v1 set both arrows' Force by hand to 16 with a Swift rune in them; without the speed the formula
  // lands on that price, and speed changed neither arrow's damage.
  { id: 'exploding_arrow', name: 'Exploding Arrow', description: 'Bursts into flame on impact.', classId: 'ranger', runes: spell('bolt[onhit] fire nova') },
  { id: 'freezing_arrow', name: 'Freezing Arrow', description: 'Leaves a patch of frost where it lands.', classId: 'ranger', runes: spell('bolt[onhit] cold zone') },
  { id: 'evade', name: 'Evade', description: 'A quick sidestep.', classId: 'ranger', runes: spell('dash[+30% speed]') },
  // Priest
  { id: 'holy_nova', name: 'Holy Nova', description: 'Heals allies around you.', classId: 'priest', runes: spell('nova[+50% size] restore') },
  { id: 'prayer', name: 'Prayer', description: 'Aura: slow regeneration for you and nearby allies.', classId: 'priest', runes: spell('aura restore') },
  // v1's Linger was 1.75x zone duration.
  { id: 'sanctuary', name: 'Sanctuary', description: 'A lasting field of healing.', classId: 'priest', runes: spell('zone[+75% duration] restore') },
  // v1's Pierce rune was 2 extra hits each.
  { id: 'smite', name: 'Smite', description: 'A piercing bolt of lightning.', classId: 'priest', runes: spell('bolt[pierce 2] lightning') },
  // Binder
  { id: 'soul_link', name: 'Soul Link', description: 'Tether to an ally or minion; they take less damage.', classId: 'binder', runes: spell('bond ward') },
  {
    id: 'bone_spear',
    name: 'Bone Spear',
    description: 'A fast spear that passes through several enemies.',
    classId: 'binder',
    runes: spell('bolt[pierce 4, +50% speed, +40% damage]'),
  },
  { id: 'corpse_blast', name: 'Corpse Blast', description: 'A burst of grave fire around you.', classId: 'binder', runes: spell('nova[+50% size] fire') },
  { id: 'frost_mire', name: 'Frost Mire', description: 'A freezing bog that slows enemies.', classId: 'binder', runes: spell('zone[+75% duration] cold') },
];

/**
 * The numbers a whole starter casts with, live-tunable (docs/features/live-tuning.md, phase 2). A
 * copy of each recipe that the registry overwrites in place; `STARTER_SIGILS` keeps the code
 * defaults, which new sigils are made with and the stored rolls of every copy are, so a retune
 * never changes what an item sells for or what comes out of it.
 */
const LIVE_RUNES: ReadonlyMap<string, readonly RuneInstance[]> = new Map(STARTER_SIGILS.map((def) => [def.id, def.runes.map(copyRune)]));

/** A copy that shares nothing mutable with the default, with its keys in the same order. */
function copyRune(r: RuneInstance): RuneInstance {
  const release = r.affixes.release;
  return { id: r.id, affixes: { ...r.affixes, ...(release ? { release: { ...release } } : {}) } };
}

/** The starter's recipe as it casts now: the code default with any live tuning applied. */
export function liveStarterRunes(def: StarterSigilDef): readonly RuneInstance[] {
  return LIVE_RUNES.get(def.id) ?? def.runes;
}

export function starterSigilById(id: string | null | undefined): StarterSigilDef | undefined {
  return id ? STARTER_SIGILS.find((s) => s.id === id) : undefined;
}

export function classStarterSigils(classId: ClassId): StarterSigilDef[] {
  return STARTER_SIGILS.filter((s) => s.classId === classId);
}

/**
 * A common sigil holding the starter's runes. `newUid` is called once for the sigil and once per
 * rune, since each rune in a slot is its own item. `bound` binds the sigil and every rune in it
 * (the starter kit); drops come unbound.
 */
export function createStarterSigil(newUid: () => ItemUid, def: StarterSigilDef, opts: { bound: boolean }): SigilItem {
  const uid = newUid();
  const item: SigilItem = {
    uid,
    kind: 'sigil',
    tier: 'common',
    name: def.name,
    ilvl: 1,
    affixes: [],
    slots: def.runes.map((r) => runeItemFromInstance(newUid(), r, opts.bound)),
    corrupted: false,
    starter: def.id,
  };
  if (opts.bound) item.bound = true;
  return item;
}
