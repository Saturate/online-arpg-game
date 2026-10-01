import { describe, expect, it } from 'vitest';
import { CLASSES, DEFAULT_TOWN_LAYOUT, freshWorld, GameMap, NAV, SIM, stepPlayer, validateLayout, type MoveState, type TownLayout, type Vec2 } from '../src/index.js';
import { findNavPath } from '../src/sim/minionPath.js';
import { FlowField } from '../src/world/nav.js';
import { emptyMap } from '../src/world/gen.js';
import { decorCollision, layoutToMap } from '../src/world/town.js';
import { townExits } from '../src/world/worldMap.js';
import liveTown from './fixtures/town-layout-live.json' with { type: 'json' };

/** The live town as pulled into git on 2026-09-30 (`pnpm town:pull`), so the test walks the town players walk. */
const live = validateLayout(liveTown, { unknownDecor: 'drop' });

const LAYOUTS: [string, TownLayout | null][] = [
  ['default', DEFAULT_TOWN_LAYOUT],
  ['live', live],
];

/**
 * Walks the hero to `to` the way click-to-move does: a nav route, cut short to the farthest point
 * in a straight line, through the real movement code. Returns where it stalled, or null on arrival.
 */
function walk(gm: GameMap, from: Vec2, to: Vec2): Vec2 | null {
  const path = findNavPath(gm, from, to, 200_000);
  if (!path) return from;
  let s: MoveState = { x: from.x, y: from.y, dash: null };
  const trail: Vec2[] = [];
  for (let t = 0; t < 60 * SIM.tickRate; t++) {
    while (path.length > 1 && Math.hypot((path[0]?.x ?? 0) - s.x, (path[0]?.y ?? 0) - s.y) < NAV.cellSize * 0.6) path.shift();
    for (let i = Math.min(path.length, 8) - 1; i > 0; i--) {
      const p = path[i];
      if (p && gm.lineClear(s.x, s.y, p.x, p.y, SIM.playerRadius, 'move')) {
        path.splice(0, i);
        break;
      }
    }
    const target = path[0];
    if (!target) return s;
    const dx = target.x - s.x;
    const dy = target.y - s.y;
    const d = Math.hypot(dx, dy);
    if (path.length === 1 && d < 10) return null;
    s = stepPlayer(gm, s, { x: dx / d, y: dy / d }, CLASSES.warrior.moveSpeed, SIM.dt, SIM.playerRadius);
    trail.push({ x: s.x, y: s.y });
    const back = trail[trail.length - 2 * SIM.tickRate];
    if (back && Math.hypot(back.x - s.x, back.y - s.y) < 8) return s;
  }
  return s;
}

describe('leaving town through its gates', () => {
  for (const [name, layout] of LAYOUTS) {
    it(`${name} town: the hero walks out of every gate, from the spawn and from beside each gate post`, () => {
      if (!layout) throw new Error('live town fixture did not validate');
      const w = freshWorld(1, layout);
      const o = w.def.townAt ?? { x: 0, y: 0 };
      const exits = townExits(layout, layoutToMap(layout));
      expect(exits.map((e) => e.side).sort()).toEqual(['east', 'north', 'south']);
      const fences = layout.props.filter((p) => p.kind === 'fence');
      for (const e of exits) {
        const inward = e.side === 'north' ? { x: 0, y: 1 } : e.side === 'south' ? { x: 0, y: -1 } : { x: -1, y: 0 };
        const out = { x: e.x + o.x - inward.x * 300, y: e.y + o.y - inward.y * 300 };
        const starts: Vec2[] = [w.def.spawn];
        // The fence ends that frame this gate: within 150 of the street's line, near the edge.
        for (const f of fences) {
          const c = Math.cos(f.angle);
          const sn = Math.sin(f.angle);
          for (const end of [-1, 1]) {
            const ex = f.x + c * (f.length / 2) * end;
            const ey = f.y + sn * (f.length / 2) * end;
            const across = inward.x === 0 ? Math.abs(ex - e.x) : Math.abs(ey - e.y);
            const depth = inward.x === 0 ? Math.abs(ey - e.y) : Math.abs(ex - e.x);
            if (across > 150 || depth > 100) continue;
            // Back along the fence from its end, just inside it: walking out hugs this post.
            for (const back of [40, 120, 240]) {
              const px = ex - c * back * end + inward.x * 30 + o.x;
              const py = ey - sn * back * end + inward.y * 30 + o.y;
              if (!w.game.pointBlocked(px, py, SIM.playerRadius + 1, 'move')) starts.push({ x: px, y: py });
            }
          }
        }
        expect(starts.length, `${name} ${e.side}: starts beside the gate posts`).toBeGreaterThan(2);
        for (const s of starts) {
          const stuck = walk(w.game, s, out);
          expect(stuck && { x: Math.round(stuck.x - o.x), y: Math.round(stuck.y - o.y) }, `${name} ${e.side} from ${Math.round(s.x - o.x)},${Math.round(s.y - o.y)}`).toBeNull();
        }
        // Monsters and minions route on the same nav cells: the way from outside the gate reaches the spawn.
        const field = new FlowField(w.game);
        field.rebuild([out]);
        expect(field.direction(w.def.spawn.x, w.def.spawn.y), `${name} ${e.side}: flow field through the gate`).not.toBeNull();
      }
    });

    it(`${name} town: the nav grid blocks every fence along its length and opens every gate`, () => {
      if (!layout) throw new Error('live town fixture did not validate');
      const w = freshWorld(1, layout);
      const o = w.def.townAt ?? { x: 0, y: 0 };
      const gm = w.game;
      const cellOpen = (x: number, y: number): boolean => {
        const c = gm.navCell(x + o.x, y + o.y);
        return gm.isWalkable(c % gm.navCols, Math.floor(c / gm.navCols));
      };
      // A fence is thinner than a cell, so the nav grid must still have no way across it: walking
      // the fence line, no step may land in an open cell that is open on both sides of the fence too.
      for (const f of layout.props.filter((p) => p.kind === 'fence')) {
        const c = Math.cos(f.angle);
        const sn = Math.sin(f.angle);
        for (let t = -f.length / 2 + 20; t <= f.length / 2 - 20; t += 10) {
          const x = f.x + c * t;
          const y = f.y + sn * t;
          expect(cellOpen(x, y) && cellOpen(x - sn * 40, y + c * 40) && cellOpen(x + sn * 40, y - c * 40), `${name} fence at ${Math.round(x)},${Math.round(y)}`).toBe(false);
        }
      }
      for (const e of townExits(layout, layoutToMap(layout))) {
        const x = e.side === 'east' ? layout.width - 60 : e.x;
        const y = e.side === 'north' ? 60 : e.side === 'south' ? layout.height - 60 : e.y;
        expect(cellOpen(x, y), `${name} ${e.side} gate cell`).toBe(true);
      }
    });
  }
});

describe('thin solid decor', () => {
  // The graveyard's split fence is 2 units thick and the wood fence 5: placed solid, a dashing hero
  // crossed its middle in a single sub-step and came out the far side.
  for (const asset of ['grave_fence_seperate', 'grave_fence', 'fence_wood_straight']) {
    it(`${asset} placed solid stops a hero walking or dashing into it from either side`, () => {
      const map = emptyMap({ name: 't', theme: 'town', width: 2000, height: 2000, spawn: { x: 1000, y: 1000 }, waves: false, safe: true, groundTint: 0 });
      const shape = decorCollision({ asset, x: 1000, y: 1000, angle: 0, scale: 1, solid: true });
      if (!shape || shape.type !== 'box') throw new Error('no box');
      map.obstacles.push({ kind: 'decor', shape, blocksMove: true, blocksShots: false, visual: 30 });
      const gm = new GameMap(map);
      // Across the thin side, through the middle of the piece.
      const across = shape.hh < shape.hw ? { x: 0, y: 1 } : { x: 1, y: 0 };
      for (const side of [-1, 1]) {
        const from = { x: shape.x - across.x * side * 120, y: shape.y - across.y * side * 120 };
        const depth = (p: Vec2): number => ((p.x - shape.x) * across.x + (p.y - shape.y) * across.y) * side;
        const lateral = (p: Vec2): number => Math.abs((p.x - shape.x) * across.y - (p.y - shape.y) * across.x);
        const longHalf = Math.max(shape.hw, shape.hh);
        // Sliding round the end of a short piece is fine; reaching the far side within its length is not.
        const through = (a: Vec2, b: Vec2): boolean => depth(a) < 0 && depth(b) >= 0 && lateral(b) < longHalf + SIM.playerRadius - 1;
        let walk: MoveState = { ...from, dash: null };
        for (let t = 0; t < 40; t++) {
          const next = stepPlayer(gm, walk, { x: across.x * side, y: across.y * side }, CLASSES.warrior.moveSpeed * 1.2, SIM.dt, SIM.playerRadius);
          expect(through(walk, next), `${asset} walking from side ${side}`).toBe(false);
          walk = next;
        }
        let dash: MoveState = { ...from, dash: { vx: across.x * side * 2400, vy: across.y * side * 2400, ticksLeft: 6 } };
        for (let t = 0; t < 6; t++) {
          const next = stepPlayer(gm, dash, { x: 0, y: 0 }, 0, SIM.dt, SIM.playerRadius);
          expect(through(dash, next), `${asset} dashing from side ${side}`).toBe(false);
          dash = next;
        }
      }
    });
  }
});
