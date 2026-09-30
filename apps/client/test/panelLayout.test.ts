import { describe, expect, it } from 'vitest';
import { clampToViewport, PANEL_GAP, parsePanelStore, snapPanel, snapToGrid } from '../src/ui/panelLayout.js';

const VIEW = { w: 1440, h: 900 };

describe('panel layout', () => {
  it('rounds to the 8 px grid', () => {
    expect(snapToGrid(0)).toBe(0);
    expect(snapToGrid(3)).toBe(0);
    expect(snapToGrid(4)).toBe(8);
    expect(snapToGrid(203)).toBe(200);
    expect(snapToGrid(-5)).toBe(-8);
  });

  it('keeps a panel fully on screen', () => {
    const size = { w: 300, h: 200 };
    expect(clampToViewport({ x: -40, y: -10 }, size, VIEW)).toEqual({ x: 0, y: 0 });
    expect(clampToViewport({ x: 1300, y: 800 }, size, VIEW)).toEqual({ x: 1140, y: 700 });
    expect(clampToViewport({ x: 500, y: 300 }, size, VIEW)).toEqual({ x: 500, y: 300 });
  });

  it('pins a panel larger than the screen to the top left', () => {
    expect(clampToViewport({ x: 50, y: 50 }, { w: 2000, h: 1200 }, VIEW)).toEqual({ x: 0, y: 0 });
  });

  it('snaps to the screen edges with the gap', () => {
    const p = snapPanel({ x: 3, y: 5, w: 300, h: 200 }, [], VIEW);
    expect(p).toEqual({ x: PANEL_GAP, y: PANEL_GAP });
    const q = snapPanel({ x: 1440 - 300 - 12, y: 900 - 200 - 2, w: 300, h: 200 }, [], VIEW);
    expect(q).toEqual({ x: 1440 - 300 - PANEL_GAP, y: 900 - 200 - PANEL_GAP });
  });

  it('falls back to the grid away from any edge', () => {
    expect(snapPanel({ x: 403, y: 197, w: 300, h: 200 }, [], VIEW)).toEqual({ x: 400, y: 200 });
  });

  it('sits beside a neighbour with the gap', () => {
    const other = { x: 500, y: 100, w: 300, h: 400 };
    // Dragged just right of the other panel, level with it.
    const right = snapPanel({ x: 813, y: 150, w: 200, h: 200 }, [other], VIEW);
    expect(right.x).toBe(800 + PANEL_GAP);
    // Dragged just left of it.
    const left = snapPanel({ x: 297, y: 150, w: 200, h: 200 }, [other], VIEW);
    expect(left.x).toBe(500 - 200 - PANEL_GAP);
  });

  it('stacks under a neighbour and lines up its edges', () => {
    const other = { x: 600, y: 40, w: 300, h: 200 };
    const p = snapPanel({ x: 604, y: 251, w: 300, h: 150 }, [other], VIEW);
    expect(p).toEqual({ x: 600, y: 240 + PANEL_GAP });
  });

  it('ignores neighbours that are not level with it', () => {
    // The other panel is far below, so its left edge must not pull this one sideways.
    const other = { x: 600, y: 700, w: 300, h: 150 };
    const p = snapPanel({ x: 594, y: 100, w: 200, h: 200 }, [other], VIEW);
    expect(p.x).toBe(592);
  });

  it('clamps after snapping', () => {
    const p = snapPanel({ x: 1500, y: -60, w: 300, h: 200 }, [], VIEW);
    expect(p).toEqual({ x: 1140, y: 0 });
  });

  it('reads saved positions and drops bad entries', () => {
    expect(parsePanelStore(null)).toEqual({ unlocked: false, positions: {} });
    expect(parsePanelStore('{broken')).toEqual({ unlocked: false, positions: {} });
    expect(parsePanelStore('[1,2]')).toEqual({ unlocked: false, positions: {} });
    const positions = { character: { x: 40, y: 80 }, menu: { x: 'a', y: 1 }, forge: { x: 1, y: null }, waypoints: 5, settings: { x: 8, y: 16 } };
    expect(parsePanelStore(JSON.stringify({ unlocked: true, positions }))).toEqual({
      unlocked: true,
      positions: { character: { x: 40, y: 80 }, settings: { x: 8, y: 16 } },
    });
    expect(parsePanelStore(JSON.stringify({ unlocked: 'yes', positions: 3 }))).toEqual({ unlocked: false, positions: {} });
  });
});
