import type { SpellTuning } from '../runes/compiler.js';
import type { ClassId } from './classes.js';
import type { RuneId } from './runes.js';

/**
 * Prebaked skills. Each is a fixed rune program with optional hand tuning on the root node, so the
 * rune engine stays the single source of behaviour while players get a fixed, readable kit.
 */
export interface SkillDef {
  id: string;
  name: string;
  description: string;
  classId: ClassId;
  runes: RuneId[];
  tuning?: Partial<SpellTuning>;
  maxEntities?: number;
  /** Hand-set heat cost. Deep rune programs get expensive by formula; prebaked skills are priced by feel. */
  heat?: number;
}

export const SKILLS: readonly SkillDef[] = [
  // Mage
  {
    id: 'fireball',
    name: 'Fireball',
    description: 'Explodes on impact and leaves the ground burning.',
    classId: 'mage',
    runes: ['bolt', 'fire', 'onhit', 'nova', 'timer', 'zone', 'linger'],
    tuning: { speed: 0.85, damage: 1.3 },
    // Priced by Force, not damage: root tuning only scales the bolt, and the burning zones that
    // stack under a pack are where the damage is. At 20 it did ~1030 DPS into 6 dummies against
    // ~680 for the next best skill; at 30 it is Force-limited to ~730.
    heat: 30,
  },
  {
    id: 'frozen_orb',
    name: 'Frozen Orb',
    description: 'A slow orb that sprays ice shards in every direction as it travels.',
    classId: 'mage',
    runes: ['bolt', 'cold', 'pulse', 'split'],
    tuning: { speed: 0.36, range: 0.85, radius: 2.2, damage: 0.6, phase: 1 },
    maxEntities: 48,
  },
  {
    id: 'static_nova',
    name: 'Static Nova',
    description: 'A wide ring of lightning that shocks everything it touches.',
    classId: 'mage',
    runes: ['nova', 'lightning', 'large'],
  },
  { id: 'blink', name: 'Blink', description: 'A long, fast dash.', classId: 'mage', runes: ['dash', 'swift', 'swift'] },
  // Warrior
  {
    id: 'leap_slam',
    name: 'Leap Slam',
    description: 'Leap forward and slam the ground, knocking enemies back.',
    classId: 'warrior',
    runes: ['dash', 'impact', 'onland', 'nova', 'large'],
    heat: 22,
  },
  { id: 'war_cry', name: 'War Cry', description: 'A shockwave that hurls enemies away.', classId: 'warrior', runes: ['nova', 'impact', 'large'] },
  {
    id: 'flame_cleave',
    name: 'Flame Cleave',
    description: 'Three burning waves in a cone.',
    classId: 'warrior',
    runes: ['bolt', 'fire', 'split'],
    tuning: { range: 0.5, radius: 1.8 },
  },
  { id: 'iron_skin', name: 'Iron Skin', description: 'Aura: you and nearby allies take less damage.', classId: 'warrior', runes: ['aura', 'ward'] },
  // Ranger
  {
    id: 'multishot',
    name: 'Multishot',
    description: 'A wide fan of piercing arrows.',
    classId: 'ranger',
    runes: ['bolt', 'pierce', 'split', 'split'],
    tuning: { damage: 1.6 },
  },
  {
    id: 'exploding_arrow',
    name: 'Exploding Arrow',
    description: 'Bursts into flame on impact.',
    classId: 'ranger',
    runes: ['bolt', 'fire', 'swift', 'onhit', 'nova'],
    heat: 16,
  },
  {
    id: 'freezing_arrow',
    name: 'Freezing Arrow',
    description: 'Leaves a patch of frost where it lands.',
    classId: 'ranger',
    runes: ['bolt', 'cold', 'swift', 'onhit', 'zone'],
    heat: 16,
  },
  { id: 'evade', name: 'Evade', description: 'A quick sidestep.', classId: 'ranger', runes: ['dash', 'swift'] },
  // Priest
  { id: 'holy_nova', name: 'Holy Nova', description: 'Heals allies around you.', classId: 'priest', runes: ['nova', 'restore', 'large'] },
  { id: 'prayer', name: 'Prayer', description: 'Aura: slow regeneration for you and nearby allies.', classId: 'priest', runes: ['aura', 'restore'] },
  { id: 'sanctuary', name: 'Sanctuary', description: 'A lasting field of healing.', classId: 'priest', runes: ['zone', 'restore', 'linger'] },
  { id: 'smite', name: 'Smite', description: 'A piercing bolt of lightning.', classId: 'priest', runes: ['bolt', 'lightning', 'pierce'] },
  // Binder
  { id: 'soul_link', name: 'Soul Link', description: 'Tether to an ally or minion; they take less damage.', classId: 'binder', runes: ['link', 'ward'] },
  {
    id: 'bone_spear',
    name: 'Bone Spear',
    description: 'A fast spear that passes through several enemies.',
    classId: 'binder',
    runes: ['bolt', 'pierce', 'pierce', 'swift'],
    tuning: { damage: 1.4 },
  },
  { id: 'corpse_blast', name: 'Corpse Blast', description: 'A burst of grave fire around you.', classId: 'binder', runes: ['nova', 'fire', 'large'] },
  { id: 'frost_mire', name: 'Frost Mire', description: 'A freezing bog that slows enemies.', classId: 'binder', runes: ['zone', 'cold', 'linger'] },
];

export function skillById(id: string | null | undefined): SkillDef | undefined {
  return id ? SKILLS.find((s) => s.id === id) : undefined;
}

export function classSkills(classId: ClassId): SkillDef[] {
  return SKILLS.filter((s) => s.classId === classId);
}
