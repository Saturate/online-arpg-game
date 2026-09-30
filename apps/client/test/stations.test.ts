import { describe, expect, it } from 'vitest';
import { HOME_ZONE } from '@rune/shared';
import { activeStation, closeStation, openStation, openWaypointMenu, type StationWindows } from '../src/ui/stations.js';

const closed: StationWindows = { station: null, waypointMenu: null, inventoryOpen: false, editorOpen: false, characterOpen: false };
const menu = { current: HOME_ZONE, unlocked: [HOME_ZONE] };

describe('station windows', () => {
  it('opening one station closes the others and shows the bag', () => {
    const trader = openStation(closed, 'trader');
    expect(trader).toEqual({ station: 'trader', waypointMenu: null, inventoryOpen: true, editorOpen: false, characterOpen: false });
    const stash = openStation(trader, 'stash');
    expect(stash.station).toBe('stash');
    expect(activeStation(stash)).toBe('stash');
  });

  it('the waypoint menu and the stations push each other out', () => {
    const wp = openWaypointMenu(openStation(closed, 'stash'), menu);
    expect(wp.station).toBeNull();
    expect(wp.waypointMenu).toEqual(menu);
    expect(openStation(wp, 'trader').waypointMenu).toBeNull();
  });

  it('the sigil editor stays with the forge and closes with it', () => {
    const forge = { ...openStation(closed, 'forge'), editorOpen: true };
    expect(openStation(forge, 'forge').editorOpen).toBe(true);
    expect(openStation(forge, 'stash').editorOpen).toBe(false);
    expect(closeStation(forge)).toEqual({ station: null, waypointMenu: null, inventoryOpen: true, editorOpen: false, characterOpen: false });
    // An editor opened from the dev tools is not the forge's to close.
    expect(closeStation({ ...openStation(closed, 'stash'), editorOpen: true }).editorOpen).toBe(true);
  });

  it('the stash and the trader take the character sheet\'s side of the screen', () => {
    const sheet = { ...closed, inventoryOpen: true, characterOpen: true };
    expect(openStation(sheet, 'stash').characterOpen).toBe(false);
    expect(openStation(sheet, 'trader').characterOpen).toBe(false);
    expect(openStation(sheet, 'forge').characterOpen).toBe(true);
  });

  it('only a station whose window is on screen takes the bag clicks', () => {
    const stash = openStation(closed, 'stash');
    expect(activeStation({ ...stash, inventoryOpen: false })).toBeNull();
    expect(activeStation({ ...stash, editorOpen: true })).toBeNull();
    expect(activeStation({ ...openStation(closed, 'forge'), editorOpen: true })).toBe('forge');
    expect(activeStation(closeStation(stash))).toBeNull();
  });
});
