import { gearBase, levelRequirement, type ClassId, type Item } from '@rune/shared';

/**
 * Pure presentation rules for items: who can use them, where a tooltip goes, and which KayKit mesh
 * (if any) an item icon is rendered from. Kept free of React and Three so it can be tested.
 */

export type Unusable = { reason: 'level'; need: number } | { reason: 'class' } | null;

/** Why the character cannot equip this, D2 style: too low a level, or a weapon for another class. */
export function unusable(item: Item, level: number, classId: ClassId): Unusable {
  const need = levelRequirement(item);
  if (need > level) return { reason: 'level', need };
  if (item.kind === 'gear') {
    const classes = gearBase(item.base)?.classes;
    if (classes && !classes.includes(classId)) return { reason: 'class' };
  }
  if (item.kind === 'vessel' && classId !== 'binder') return { reason: 'class' };
  return null;
}

/**
 * Tooltip position beside the cursor that never leaves the viewport: prefer below-right, flip to
 * the other side when it would overflow, and clamp as a last resort.
 */
export function placeTooltip(x: number, y: number, w: number, h: number, vw: number, vh: number, offset = 18, margin = 8): { left: number; top: number } {
  let left = x + offset;
  if (left + w > vw - margin) left = x - offset - w;
  let top = y + offset;
  if (top + h > vh - margin) top = y - offset - h;
  return {
    left: Math.max(margin, Math.min(left, vw - margin - w)),
    top: Math.max(margin, Math.min(top, vh - margin - h)),
  };
}

export interface IconModel {
  url: string;
  /** Mesh node to pull out of a character model; absent when the file is the item itself. */
  node?: string;
  /** Degrees to spin the model around its long axis so the flat side faces the camera. */
  spin?: number;
}

const K = '/assets/kaykit';

/**
 * Bases that have a matching KayKit mesh: the weapons the heroes and skeletons carry, and two
 * helmets. Armour worn as part of a body mesh has no standalone model and keeps its drawn icon.
 */
export const ICON_MODELS: Readonly<Record<string, IconModel>> = {
  rusty_axe: { url: `${K}/skeletons/Skeleton_Axe.gltf` },
  war_axe: { url: `${K}/adventurers/Barbarian.glb`, node: '2H_Axe' },
  short_bow: { url: `${K}/adventurers/Rogue.glb`, node: '1H_Crossbow' },
  recurve_bow: { url: `${K}/adventurers/Rogue.glb`, node: '2H_Crossbow' },
  gnarled_staff: { url: `${K}/skeletons/Skeleton_Staff.gltf` },
  runed_staff: { url: `${K}/adventurers/Mage.glb`, node: '2H_Staff' },
  bone_wand: { url: `${K}/adventurers/Mage.glb`, node: '1H_Wand' },
  grave_sceptre: { url: `${K}/skeletons/Skeleton_Blade.gltf` },
  leather_cap: { url: `${K}/adventurers/Barbarian.glb`, node: 'Barbarian_Hat' },
  iron_helm: { url: `${K}/adventurers/Knight.glb`, node: 'Knight_Helmet' },
};

export function iconModelFor(item: Item): { key: string; model: IconModel } | null {
  if (item.kind !== 'gear') return null;
  const model = ICON_MODELS[item.base];
  return model ? { key: item.base, model } : null;
}

/** Up to five pips under an icon, one per affix, so a loaded rare stands out in the grid. */
export function affixPips(item: Item): number {
  return Math.min(5, item.affixes.length);
}
