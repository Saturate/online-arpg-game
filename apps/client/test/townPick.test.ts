import { describe, expect, it } from 'vitest';
import { playerInTownAt, type TownPlayer } from '../src/game/townPick.js';

const pal: TownPlayer = { x: 100, y: 100, r: 14, name: 'Pal', tag: 'ASH' };
const town = { safe: false, safeZones: [{ x: 0, y: 0, w: 300, h: 300 }] };

describe('right-click on a player', () => {
  it('picks a player only inside a safe area, so the right button still casts outside town', () => {
    expect(playerInTownAt(town, [pal], { x: 105, y: 100 })?.name).toBe('Pal');
    expect(playerInTownAt({ safe: false, safeZones: [] }, [pal], { x: 105, y: 100 })).toBeNull();
    expect(playerInTownAt({ safe: false }, [{ ...pal, x: 500, y: 500 }], { x: 505, y: 500 })).toBeNull();
    expect(playerInTownAt({ safe: true }, [pal], { x: 105, y: 100 })?.tag).toBe('ASH');
  });

  it('misses when the click is clear of everyone, and takes the nearest of two', () => {
    expect(playerInTownAt(town, [pal], { x: 200, y: 200 })).toBeNull();
    const near: TownPlayer = { ...pal, x: 120, name: 'Near' };
    expect(playerInTownAt(town, [pal, near], { x: 122, y: 100 })?.name).toBe('Near');
  });
});
