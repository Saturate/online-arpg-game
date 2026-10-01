import { describe, expect, it } from 'vitest';
import { freshWorld, planChecksum, SIM, stepPlayer, validateLayout, WORLD, type GateInfo, type MoveState, type Vec2, type WorldMap, type WorldPlan } from '../src/index.js';
import { distToShape } from '../src/world/gen.js';
import { traceSeal } from '../src/world/worldMap.js';
import liveTown from './fixtures/town-layout-live.json' with { type: 'json' };

/** Seeds to check: the live public world's (with the live town), and others, one (85369) with a river along a seal. */
const WORLDS: { seed: number; live: boolean }[] = [
  { seed: 904226, live: true },
  { seed: 3, live: false },
  { seed: 7, live: false },
  { seed: 85369, live: false },
];
const BODY = SIM.playerRadius;
/** The opening between the arch's legs: the trunk's half width, its clearance and a little (`GATE_LEG`). */
const OPENING = WORLD.trunkWidth + 34 + 10;

const live = validateLayout(liveTown, { unknownDecor: 'drop' });

function build(w: { seed: number; live: boolean }) {
  if (!live) throw new Error('the live town fixture does not validate');
  return freshWorld(w.seed, w.live ? live : undefined);
}

/**
 * Points on the seal's line found without the tracer: cells of a grid whose corner and a neighbour
 * lie on different sides of the rule.
 */
function frontier(plan: WorldPlan, def: WorldMap, g: GateInfo, step = 20): Vec2[] {
  const out: Vec2[] = [];
  const R = 7000;
  const x0 = Math.max(0, g.x - R);
  const y0 = Math.max(0, g.y - R);
  const nx = Math.ceil((Math.min(def.width, g.x + R) - x0) / step);
  const ny = Math.ceil((Math.min(def.height, g.y + R) - y0) / step);
  const st = new Uint8Array((nx + 1) * (ny + 1));
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) st[j * (nx + 1) + i] = plan.gateAt(x0 + i * step, y0 + j * step) === g.id ? 1 : 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = st[j * (nx + 1) + i];
      if (a !== st[j * (nx + 1) + i + 1] || a !== st[(j + 1) * (nx + 1) + i]) out.push({ x: x0 + i * step + step / 2, y: y0 + j * step + step / 2 });
    }
  }
  return out;
}

const inMap = (def: WorldMap, p: Vec2, margin: number): boolean => p.x > margin && p.y > margin && p.x < def.width - margin && p.y < def.height - margin;

describe('gate walls', () => {
  it('draws the seal as a ridge with no gap a body fits through, across rivers too, open only under the arch', () => {
    for (const w of WORLDS) {
      const { def, plan } = build(w);
      const pieces = def.obstacles.filter((o) => o.blocksMove && o.kind !== 'water');
      const water = def.obstacles.filter((o) => o.kind === 'water');
      for (const g of def.gates ?? []) {
        const line = frontier(plan, def, g);
        expect(line.length).toBeGreaterThan(200);
        const open: Vec2[] = [];
        for (const p of line) {
          if (!inMap(def, p, 80) || Math.hypot(p.x - g.x, p.y - g.y) < OPENING + 10) continue;
          // A grid cell's centre is up to half a diagonal off the line, so the piece must reach that far plus a body.
          if (pieces.some((o) => distToShape(p.x, p.y, o.shape) < BODY)) continue;
          // Only where a bridge keeps rocks off the water does the river alone hold the line.
          const nearBridge = def.bridges.some((b) => Math.hypot(p.x - b.x, p.y - b.y) < b.length / 2 + 80 + 70);
          if (nearBridge && water.some((o) => distToShape(p.x, p.y, o.shape) <= 0)) continue;
          open.push(p);
        }
        expect(open, `seed ${w.seed} ${g.id}`).toEqual([]);
        // The road under the arch stays open for those who have the gate.
        expect(pieces.some((o) => distToShape(g.x, g.y, o.shape) < OPENING - 18 - BODY)).toBe(false);
      }
    }
  });

  it('lays the arch across the road and each wall piece along the line', () => {
    for (const w of WORLDS) {
      const { def, plan } = build(w);
      for (const g of def.gates ?? []) {
        // Decor turns the model's x axis (the arch's span) to its angle: across the road means square to the heading.
        const arch = def.decor.find((d) => d.asset === 'grave_arch' && Math.hypot(d.x - g.x, d.y - g.y) < 1);
        expect(arch).toBeDefined();
        expect(Math.abs(Math.cos((arch?.angle ?? g.angle) - g.angle))).toBeLessThan(1e-9);
        // The pass's walls (other walls, a ruin's, can stand nearby); a river through the pass would take rocks instead.
        const walls = def.obstacles.filter((o) => o.kind === 'wall' && o.shape.type === 'capsule' && Math.hypot(o.shape.ax - g.x, o.shape.ay - g.y) < OPENING + 360 && Math.hypot(o.shape.bx - g.x, o.shape.by - g.y) < OPENING + 360);
        expect(walls.length, `seed ${w.seed} ${g.id}`).toBeGreaterThanOrEqual(4);
        const near = (x: number, y: number): boolean => {
          const here = plan.gateAt(x, y) === g.id;
          for (let k = 0; k < 16; k++) {
            const a = (k / 16) * Math.PI * 2;
            if ((plan.gateAt(x + Math.cos(a) * 12, y + Math.sin(a) * 12) === g.id) !== here) return true;
          }
          return false;
        };
        for (const o of walls) {
          if (o.shape.type !== 'capsule') continue;
          const { ax, ay, bx, by } = o.shape;
          const leg = Math.hypot(ax - g.x, ay - g.y) < OPENING + 1;
          // Both ends and the middle on the line (the first piece starts at the arch's leg, beside it).
          if (!leg) expect(near(ax, ay), `seed ${w.seed} ${g.id} wall start`).toBe(true);
          expect(near(bx, by), `seed ${w.seed} ${g.id} wall end`).toBe(true);
          expect(near((ax + bx) / 2, (ay + by) / 2), `seed ${w.seed} ${g.id} wall middle`).toBe(true);
        }
      }
    }
  });

  it('blocks as it is drawn: one who has the gate is stopped by the ridge, the seal rule is unchanged', () => {
    for (const w of WORLDS.slice(0, 2)) {
      const { def, game, plan } = build(w);
      const seal = { plan, opened: (def.gates ?? []).map((g) => g.id) };
      for (const g of def.gates ?? []) {
        for (const side of [1, -1]) {
          const line = traceSeal(plan, g.id, g, g.angle + (side * Math.PI) / 2, side < 0, def.width, def.height);
          for (let i = 20; i < line.length - 3; i += 12) {
            const p = line[i];
            const q = line[i + 1];
            if (!p || !q || !inMap(def, p, 200)) continue;
            // The normal toward the town side of the line, by the rule.
            let tx = -(q.y - p.y);
            let ty = q.x - p.x;
            const len = Math.hypot(tx, ty);
            tx /= len;
            ty /= len;
            if (plan.gateAt(p.x + tx * 60, p.y + ty * 60) === g.id) {
              tx = -tx;
              ty = -ty;
            }
            let state: MoveState = { x: p.x + tx * 90, y: p.y + ty * 90, dash: null };
            if (game.pointBlocked(state.x, state.y, BODY, 'move')) continue;
            for (let k = 0; k < 40; k++) state = stepPlayer(game, state, { x: -tx, y: -ty }, 300, SIM.dt, BODY, seal);
            expect(plan.gateAt(state.x, state.y), `seed ${w.seed} ${g.id} at ${Math.round(p.x)},${Math.round(p.y)}`).not.toBe(g.id);
          }
        }
      }
    }
    // The rule is the plan's, which the walls leave alone: the hash from before they were traced, so
    // servers and clients of either build agree on where the seal runs.
    expect(planChecksum(freshWorld(3).plan)).toBe('6ad71b81');
  });

  it('traces the same line on every build', () => {
    const a = freshWorld(7);
    const b = freshWorld(7);
    const rocks = (def: WorldMap) => def.obstacles.filter((o) => o.kind === 'rock' || o.kind === 'wall').map((o) => JSON.stringify(o.shape));
    expect(rocks(a.def)).toEqual(rocks(b.def));
    for (const g of a.def.gates ?? []) expect(traceSeal(a.plan, g.id, g, g.angle + Math.PI / 2, false, a.def.width, a.def.height)).toEqual(traceSeal(b.plan, g.id, g, g.angle + Math.PI / 2, false, b.def.width, b.def.height));
  });
});
