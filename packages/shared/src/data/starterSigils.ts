import { runeItemFromInstance, type ItemUid, type SigilItem } from '../items/items.js';
import { tokenizeSpell } from '../runes/v2/tokenize.js';
import type { RuneInstance } from '../runes/v2/runes.js';
import type { ClassId } from './classes.js';

/**
 * The built-in skills as starter sigils: common sigils holding pre-rolled runes, so their numbers
 * are readable, copyable and improvable like any hand-built spell. The rune lists reproduce the v1
 * hand tuning where the grammar can express it; where it cannot, the entry says so.
 *
 * Numbers are relative to each shape's base. An Orb is a slow, big bolt (0.55 speed, 2x size,
 * 1.3x range of a Bolt), so an orb's affixes are the old tuning divided by that.
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
    // PLAN-runes.md's Fireball, not a copy of v1 (a bolt at 0.85 speed and 2x damage, Force set by
    // hand to 24): the balance pass tunes it against the v1 baseline.
    runes: spell('orb[onhit, -15% speed, +30% damage] fire nova[after 0.5s] zone[long]'),
  },
  {
    id: 'frozen_orb',
    name: 'Frozen Orb',
    description: 'A slow orb that sprays ice shards in every direction as it travels.',
    classId: 'mage',
    // v1: speed 0.36, range 0.85, radius 2.2, damage 0.6 on a bolt. It passed through everything
    // (phase); no affix does that yet, so pierce 20 stands in. v1 also let it exceed the entity cap
    // (48); the grammar's live cap is 40 and it peaks well under that.
    runes: spell('orb[every 0.18s, -35% speed, -35% duration, +10% size, -40% damage, pierce 20] cold split(3) bolt'),
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
  { id: 'flame_cleave', name: 'Flame Cleave', description: 'Three burning waves in a cone.', classId: 'warrior', runes: spell('bolt[-50% duration, +80% size] fire split(3)') },
  { id: 'iron_skin', name: 'Iron Skin', description: 'Aura: you and nearby allies take less damage.', classId: 'warrior', runes: spell('aura ward') },
  // Ranger
  { id: 'multishot', name: 'Multishot', description: 'A wide fan of piercing arrows.', classId: 'ranger', runes: spell('bolt[pierce 2, +60% damage] split(3) split(3)') },
  // v1 set both arrows' Force by hand to 16; the formula prices them now. v1's Swift was 1.5x bolt speed.
  { id: 'exploding_arrow', name: 'Exploding Arrow', description: 'Bursts into flame on impact.', classId: 'ranger', runes: spell('bolt[onhit, +50% speed] fire nova') },
  { id: 'freezing_arrow', name: 'Freezing Arrow', description: 'Leaves a patch of frost where it lands.', classId: 'ranger', runes: spell('bolt[onhit, +50% speed] cold zone') },
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
