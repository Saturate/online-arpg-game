import { PROP_DEFS, TOWN_DECOR_ASSETS, TOWN_PROP_KINDS, type TownPropKind } from '@rune/shared';
import { ASSETS, type AssetCategory } from '../render/assets.js';
import { PROCEDURAL_DECOR } from '../render/props.js';

/**
 * The town editor's palette: every prop kind the layout knows and every asset it can place as
 * decor, grouped and searchable. Kept free of three.js rendering so it can be tested.
 */

export type PlaceItem = { type: 'prop'; kind: TownPropKind } | { type: 'decor'; asset: string };

export const PALETTE_GROUPS = ['Town pieces', 'Buildings', 'Walls and fences', 'Props', 'Lights and fires', 'Graveyard', 'Dungeon', 'Nature'] as const;
export type PaletteGroup = (typeof PALETTE_GROUPS)[number];

export interface PaletteEntry {
  /** `prop:<kind>` or `decor:<asset>`; also the thumbnail's cache key. */
  key: string;
  item: PlaceItem;
  label: string;
  group: PaletteGroup;
  /** What the piece does in the game, shown under the name ("the stash", "blocks"). */
  hint: string;
}

const CATEGORY_GROUP: Partial<Record<AssetCategory, PaletteGroup>> = {
  building: 'Buildings',
  wall: 'Walls and fences',
  prop: 'Props',
  light: 'Lights and fires',
  graveyard: 'Graveyard',
  dungeon: 'Dungeon',
  nature: 'Nature',
};

const PROP_HINT: Partial<Record<TownPropKind, string>> = {
  chest: 'the stash',
  stall: 'the trader',
  lamp: 'lit at night',
  fence: 'a line',
  wall: 'a line',
};

export function placeKey(item: PlaceItem): string {
  return item.type === 'prop' ? `prop:${item.kind}` : `decor:${item.asset}`;
}

function capital(s: string): string {
  return s.replace(/^./, (c) => c.toUpperCase());
}

/** A decor asset's name and palette group, for the palette, the layer list and the selection line. */
export function decorInfo(asset: string): { label: string; group: PaletteGroup; height: number } {
  const proc = PROCEDURAL_DECOR[asset];
  if (proc) return { label: proc.label, group: 'Lights and fires', height: proc.height };
  const def = ASSETS.find((a) => a.id === asset);
  return { label: capital(def?.label ?? asset.replace(/_/g, ' ')), group: (def && CATEGORY_GROUP[def.category]) ?? 'Props', height: def?.height ?? 30 };
}

let cached: PaletteEntry[] | null = null;

/** Every placeable piece: the layout's prop kinds first, then decor by group and name. */
export function paletteEntries(): PaletteEntry[] {
  if (cached) return cached;
  const props: PaletteEntry[] = TOWN_PROP_KINDS.map((kind) => ({ key: `prop:${kind}`, item: { type: 'prop', kind }, label: PROP_DEFS[kind].label, group: 'Town pieces', hint: PROP_HINT[kind] ?? '' }));
  // Only what the server accepts in a saved town (TOWN_DECOR_ASSETS, generated from this registry).
  const decor: PaletteEntry[] = Object.entries(TOWN_DECOR_ASSETS).map(([asset, spec]) => {
    const info = decorInfo(asset);
    const hint = asset === 'weaponrack' ? 'the forge' : spec.lit ? 'lit at night' : spec.solid ? 'blocks' : '';
    return { key: `decor:${asset}`, item: { type: 'decor', asset }, label: info.label, group: info.group, hint };
  });
  const order = (g: PaletteGroup) => PALETTE_GROUPS.indexOf(g);
  decor.sort((a, b) => order(a.group) - order(b.group) || a.label.localeCompare(b.label));
  cached = [...props, ...decor];
  return cached;
}

/** Case-insensitive: every word must appear in the name, the group, the hint or the asset id. */
export function filterPalette(entries: readonly PaletteEntry[], query: string): PaletteEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...entries];
  return entries.filter((e) => {
    const text = `${e.label} ${e.group} ${e.hint} ${e.key.replace(/_/g, ' ')}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

export function groupPalette(entries: readonly PaletteEntry[]): { group: PaletteGroup; entries: PaletteEntry[] }[] {
  return PALETTE_GROUPS.map((group) => ({ group, entries: entries.filter((e) => e.group === group) })).filter((g) => g.entries.length > 0);
}
