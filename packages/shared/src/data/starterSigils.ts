import { runeItemFromInstance, type ItemUid, type SigilItem } from '../items/items.js';
import { tokenizeSpell } from '../runes/v2/tokenize.js';
import type { RuneInstance } from '../runes/v2/runes.js';
import type { ClassId } from './classes.js';

/**
 * Each class's first skills (the kit): ordinary common sigils holding ordinary rolled runes. A
 * recipe only says which runes and rolls a new character gets; every roll lies inside the drop
 * tables (docs/features/live-tuning.md, "No starters as a special kind"), so a kit sigil casts,
 * prices and comes apart like any sigil a player builds. The `starter` id on the item only names it.
 *
 * The recipes used to carry hand-set rolls beyond the tables (Fireball's +100% damage Orb, Frozen
 * Orb's slowed orb and 0.18 s pulse); those were clamped to the best roll a drop below T1 can have,
 * and drawbacks no drop rolls (negative speed, size, duration or damage) were dropped. How much each
 * kit lost is in docs/features/runes.md, "Kit sigils at table rolls".
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
    // v1 had Linger (+75% duration), but one caster's zones never stack and it recasts long before
    // the ground goes out, so the extra time added no damage while its payload price pushed Force up.
    runes: spell('orb[onhit, +55% damage] fire nova[after 0.5s] zone[+30% duration]'),
  },
  {
    id: 'frozen_orb',
    name: 'Frozen Orb',
    description: 'A slow orb that sprays ice shards in every direction as it travels.',
    classId: 'mage',
    // An orb passes through everything by itself. A ring of three shards faces any one target with
    // little of it, so its repeat releases add only a few Force.
    runes: spell('orb[every 0.2s, +10% size] cold split(3) bolt'),
  },
  { id: 'static_nova', name: 'Static Nova', description: 'A wide ring of lightning that shocks everything it touches.', classId: 'mage', runes: spell('nova[+50% size] lightning') },
  { id: 'blink', name: 'Blink', description: 'A long, fast dash.', classId: 'mage', runes: spell('dash[+50% speed]') },
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
  // Sigils that still hold v1's three short fire waves are rebuilt on load (items/convertRuneRolls.ts).
  { id: 'flame_cleave', name: 'Flame Cleave', description: 'A ring of fire that burns everything close around you.', classId: 'warrior', runes: spell('nova[+50% damage] fire') },
  { id: 'iron_skin', name: 'Iron Skin', description: 'Aura: you and nearby allies take less damage.', classId: 'warrior', runes: spell('aura ward') },
  // Ranger
  // Sigils that still hold v1's nine arrows are rebuilt on load (items/convertRuneRolls.ts).
  { id: 'multishot', name: 'Multishot', description: 'A wide fan of piercing arrows.', classId: 'ranger', runes: spell('bolt[pierce 2, +55% damage] split(5)') },
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
    runes: spell('bolt[pierce 3, +50% speed, +40% damage]'),
  },
  { id: 'corpse_blast', name: 'Corpse Blast', description: 'A burst of grave fire around you.', classId: 'binder', runes: spell('nova[+50% size] fire') },
  { id: 'frost_mire', name: 'Frost Mire', description: 'A freezing bog that slows enemies.', classId: 'binder', runes: spell('zone[+75% duration] cold') },
];

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
