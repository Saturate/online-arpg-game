import type { TownPropKind } from '@rune/shared';
import type { Object3D } from 'three';
import type { PaletteEntry } from '../game/townPalette.js';
import { assetById, instantiate } from '../render/assets.js';
import { previewObject } from '../render/props.js';
import { requestObjectIcon } from './itemIconRenderer.js';

/** The model each layout prop kind is drawn with in town (props.ts buildWorld); stall and trees are built in code. */
const PROP_MODEL: Partial<Record<TownPropKind, string>> = {
  house: 'building_home_A_red',
  cottage: 'building_home_B_red',
  well: 'building_well_blue',
  chest: 'dungeon_chest',
  crate: 'dungeon_crates_stacked',
  rock: 'rock_single_C',
  pillar: 'dungeon_pillar',
  lamp: 'grave_post_lantern',
  fence: 'fence_wood_straight',
  wall: 'dungeon_wall_broken',
};

async function build(entry: PaletteEntry): Promise<Object3D | null> {
  const built = previewObject(entry.item.type === 'prop' ? entry.key : entry.item.asset);
  if (built) return built;
  const def = assetById(entry.item.type === 'prop' ? (PROP_MODEL[entry.item.kind] ?? '') : entry.item.asset);
  return def ? (await instantiate(def)).root : null;
}

export function thumbKey(entry: PaletteEntry): string {
  return `town:${entry.key}`;
}

/**
 * Renders a palette tile's thumbnail once per session. Called when a tile scrolls into view, so
 * opening the editor loads only the models of the tiles on screen, never the whole kit.
 */
export function requestTownThumb(entry: PaletteEntry): void {
  requestObjectIcon(thumbKey(entry), () => build(entry));
}
