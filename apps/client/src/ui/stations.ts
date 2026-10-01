import type { WaypointInfo } from '@rune/shared';

/**
 * A town station whose window works together with the bag. In town the chest sits inside the
 * trader's reach, so being in reach of one says nothing about which one the player meant: only
 * one station window is open at a time, and the bag's quick clicks go to that one alone.
 */
export type ItemStation = 'stash' | 'trader' | 'forge';

export interface WaypointMenu {
  current: string;
  unlocked: string[];
  /** Every waypoint of the world, in menu order. */
  list: WaypointInfo[];
}

/** The slice of the UI store the station windows live in. */
export interface StationWindows {
  station: ItemStation | null;
  waypointMenu: WaypointMenu | null;
  inventoryOpen: boolean;
  editorOpen: boolean;
  characterOpen: boolean;
}

/** Opening a station closes every other one, the waypoint menu included, and shows the bag. */
export function openStation(s: StationWindows, kind: ItemStation): StationWindows {
  const beside = kind === 'stash' || kind === 'trader';
  return {
    station: kind,
    waypointMenu: null,
    inventoryOpen: true,
    // The sigil editor belongs to the forge (or the dev tools); it would hide the stash and the bag.
    editorOpen: kind === 'forge' && s.editorOpen,
    // Like D2, the stash and the shelf take the left of the screen where the character sheet sits:
    // on a 1600x900 screen there is no spot left for the sheet beside them and the bag.
    characterOpen: !beside && s.characterOpen,
  };
}

export function openWaypointMenu(s: StationWindows, menu: WaypointMenu): StationWindows {
  return { ...closeStation(s), waypointMenu: menu };
}

/** Walking away, Escape or closing the bag: the station is closed for real, not just hidden. */
export function closeStation(s: StationWindows): StationWindows {
  return { station: null, waypointMenu: null, inventoryOpen: s.inventoryOpen, editorOpen: s.station === 'forge' ? false : s.editorOpen, characterOpen: s.characterOpen };
}

/**
 * The station the bag's right-click and Ctrl/Cmd+click act on: the open one, and only while its
 * window is on screen. The stash hides under the sigil editor, so it takes no clicks then.
 */
export function activeStation(s: StationWindows): ItemStation | null {
  if (!s.inventoryOpen || s.station === null) return null;
  if (s.editorOpen && s.station !== 'forge') return null;
  return s.station;
}
