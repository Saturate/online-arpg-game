import { WORLD } from '../config/sim.js';
import type { Biome } from '../data/monsterPools.js';
import { ZONES, type ZoneDef, type ZoneId } from '../data/zones.js';
import type { Vec2 } from '../sim/math.js';
import { Rng } from '../sim/rng.js';
import { distToSegment } from './gen.js';

/**
 * The seamless world's plan: a tree of roads from the town at the centre. Pure and seeded, so the
 * server and every client build the same one from the world seed.
 *
 * Three roads leave the town's gates, each into a sector of its own (a third of the circle). Each
 * road's trunk runs out to the map edge through the home region around the town, its first region,
 * a gate node, and (on two of the roads) a second region beyond it. Branches split off the trunk at
 * forks and end in dead ends that hold a rare pack, a chest, a dungeon entrance or a region's boss;
 * camps and ruins sit in the side valleys beside the branches.
 *
 * Distance from town is walking distance along the roads (graph distance) plus a share of the
 * distance off the road, and monster level, pack density and pack size all follow it. A spot's
 * region is the region of the nearest road.
 */

export type RoadSide = 'north' | 'east' | 'south' | 'west';

const SIDE_ANGLE: Record<RoadSide, number> = { north: -Math.PI / 2, east: 0, south: Math.PI / 2, west: Math.PI };

/** The region around the town, where every road starts. */
export const HOME_REGION: ZoneId = 'barrens';

/** The town's own waypoint, beside the spawn; everyone has it. */
export const TOWN_WAYPOINT = 'town';

/** Region themes per road (today's zones), roads taken clockwise from the west: first region, then the one past its gate. */
const ROAD_THEMES: readonly (readonly ZoneId[])[] = [['gloomvale', 'hollows'], ['steppe', 'dunes'], ['thornwood']];

export interface WorldNode {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly parent: number | null;
  /** Walking distance from the town gate along the roads. */
  readonly depth: number;
  readonly region: ZoneId;
  /** Index into `roads`; -1 for the town. */
  readonly road: number;
  readonly trunk: boolean;
  readonly children: number[];
  /** The gate between this node and the town, or null: what stage 2's gate bosses will check. */
  readonly behind: string | null;
}

export interface WorldEdge {
  readonly a: number;
  readonly b: number;
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
  readonly depthA: number;
  readonly length: number;
  readonly region: ZoneId;
  /** Index into `roads`. */
  readonly road: number;
  /** Half width of the road drawn along it. */
  readonly width: number;
}

export interface PlanRoad {
  readonly side: RoadSide;
  /** The middle of the road's sector, seen from the centre. */
  readonly angle: number;
  readonly regions: readonly ZoneId[];
  readonly exit: Vec2;
}

export interface PlanRegion {
  readonly id: ZoneId;
  readonly def: ZoneDef;
  /** Index into `roads`, or null for the home region. */
  readonly road: number | null;
  /** Monster levels from its nearest point to town to its farthest. */
  readonly levels: readonly [number, number];
}

export interface PlanWaypoint {
  readonly id: string;
  readonly name: string;
  readonly node: number;
  readonly region: ZoneId;
}

/** A narrow pass a gate boss will hold (stage 2); passable for now. */
export interface PlanGate {
  readonly id: string;
  readonly node: number;
  readonly road: number;
  /** The region the gate leads into. */
  readonly region: ZoneId;
  /** The road's heading through the gate. */
  readonly angle: number;
}

export type SpotKind = 'boss' | 'dungeon' | 'rare' | 'chest' | 'camp' | 'ruin';

/** Where the plan wants something: the map builder finds open ground near it. */
export interface PlanSpot {
  readonly kind: SpotKind;
  readonly x: number;
  readonly y: number;
  readonly node: number;
  readonly region: ZoneId;
}

export interface WorldPlanInput {
  seed: number;
  width: number;
  height: number;
  /** The town's rectangle in world coordinates. */
  town: { x: number; y: number; w: number; h: number };
  /** Where each road leaves the town, on the town's edge, and which side of the town it is on. */
  exits: readonly { x: number; y: number; side: RoadSide }[];
}

const TAU = Math.PI * 2;

/** The signed difference a - b, wrapped into [-pi, pi). */
function angleDiff(a: number, b: number): number {
  return ((((a - b + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
}

/** Lookup cells for the nearest road, in world units. */
const CELL = 250;

interface MutableNode {
  id: number;
  x: number;
  y: number;
  parent: number | null;
  depth: number;
  region: ZoneId;
  road: number;
  trunk: boolean;
  children: number[];
  behind: string | null;
}

export class WorldPlan {
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  readonly centre: Vec2;
  readonly town: { x: number; y: number; w: number; h: number };
  readonly nodes: readonly WorldNode[];
  readonly edges: readonly WorldEdge[];
  readonly roads: readonly PlanRoad[];
  readonly regions: ReadonlyMap<ZoneId, PlanRegion>;
  readonly waypoints: readonly PlanWaypoint[];
  readonly gates: readonly PlanGate[];
  readonly spots: readonly PlanSpot[];
  /**
   * Per road, its deepest branch end's distance from town: the top of the level curve there. Each
   * road's far end is the hardest, however long its sector lets it run.
   */
  readonly roadDepth: readonly number[];
  private readonly cols: number;
  private readonly rows: number;
  /** Per lookup cell, the edges that can be nearest to a point in it; worked out on first use. */
  private readonly cellEdges: (Int32Array | undefined)[];
  private readonly list: MutableNode[] = [];
  private readonly edgeList: WorldEdge[] = [];

  constructor(input: WorldPlanInput) {
    this.seed = input.seed;
    this.width = input.width;
    this.height = input.height;
    this.town = input.town;
    const c = { x: input.width / 2, y: input.height / 2 };
    this.centre = c;
    const root = this.addNode(c.x, c.y, null, HOME_REGION, -1, true, null);

    const angleOf = (p: Vec2): number => Math.atan2(p.y - c.y, p.x - c.x);
    const exits = [...input.exits].sort((a, b) => angleOf(a) - angleOf(b)).slice(0, ROAD_THEMES.length);
    // Sector middles a third of a circle apart, as close to the gates' own directions as they can be.
    const step = TAU / Math.max(1, exits.length);
    // The circular mean of each gate's angle less its place in the order.
    let sx = 0;
    let sy = 0;
    for (const [k, e] of exits.entries()) {
      sx += Math.cos(angleOf(e) - k * step);
      sy += Math.sin(angleOf(e) - k * step);
    }
    const first = Math.atan2(sy, sx);
    this.roads = exits.map((e, k) => ({ side: e.side, angle: angleDiff(first + k * step, 0), regions: ROAD_THEMES[k] ?? ['thornwood'], exit: { x: e.x, y: e.y } }));

    const waypoints: PlanWaypoint[] = [];
    const gates: PlanGate[] = [];
    const trunks: number[][] = [];
    for (const [k, road] of this.roads.entries()) trunks.push(this.trunk(k, road, root, waypoints, gates));
    for (const [k, road] of this.roads.entries()) {
      const nodes = trunks[k];
      if (nodes) this.branches(k, road, nodes);
    }

    this.nodes = this.list;
    this.edges = this.edgeList;
    this.waypoints = waypoints;
    this.gates = gates;
    const ends = this.list.filter((n) => n.children.length === 0 && n.parent !== null);
    this.roadDepth = this.roads.map((_, k) => Math.max(1, ...ends.filter((n) => n.road === k).map((n) => n.depth)));
    this.cols = Math.ceil(input.width / CELL);
    this.rows = Math.ceil(input.height / CELL);
    this.cellEdges = new Array<Int32Array | undefined>(this.cols * this.rows);
    this.spots = this.placeSpots(ends);
    this.regions = this.regionTable();
  }

  private addNode(x: number, y: number, parent: MutableNode | null, region: ZoneId, road: number, trunk: boolean, behind: string | null, drawn = true): MutableNode {
    const length = parent ? Math.hypot(x - parent.x, y - parent.y) : 0;
    // The way from the town's middle to a gate is the town's own streets: distance starts at the gate.
    const node: MutableNode = { id: this.list.length, x, y, parent: parent?.id ?? null, depth: (parent?.depth ?? 0) + (drawn ? length : 0), region, road, trunk, children: [], behind };
    this.list.push(node);
    if (parent) {
      parent.children.push(node.id);
      // The town's own streets lead to its gates; the world's roads start there.
      if (drawn) {
        const width = trunk ? WORLD.trunkWidth : WORLD.branchWidth;
        this.edgeList.push({ a: parent.id, b: node.id, ax: parent.x, ay: parent.y, bx: x, by: y, depthA: parent.depth, length, region, road, width });
      }
    }
    return node;
  }

  private inBounds(x: number, y: number): boolean {
    const m = WORLD.edgeMargin;
    return x >= m && y >= m && x <= this.width - m && y <= this.height - m;
  }

  /** How far from the centre a ray at `angle` can go before the map margin. */
  private reach(angle: number): number {
    const m = WORLD.edgeMargin;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const tx = dx > 1e-9 ? (this.width - m - this.centre.x) / dx : dx < -1e-9 ? (m - this.centre.x) / dx : Infinity;
    const ty = dy > 1e-9 ? (this.height - m - this.centre.y) / dy : dy < -1e-9 ? (m - this.centre.y) / dy : Infinity;
    return Math.min(tx, ty);
  }

  private inSector(road: PlanRoad, x: number, y: number, inset: number): boolean {
    return Math.abs(angleDiff(Math.atan2(y - this.centre.y, x - this.centre.x), road.angle)) <= WORLD.sectorHalf - inset;
  }

  /**
   * A road's trunk from its gate to the map edge, through the home region, its first region and the
   * gate node. Returns the trunk's nodes, the gate's exit first.
   */
  private trunk(k: number, road: PlanRoad, root: MutableNode, waypoints: PlanWaypoint[], gates: PlanGate[]): number[] {
    const rng = Rng.stream(this.seed, `world:road:${k}`);
    const c = this.centre;
    // Aimed off the sector's middle, so trunks are not all straight lines and one side gets the room.
    const aim = road.angle + rng.range(-0.35, 0.35);
    const reach = this.reach(aim);
    const target = { x: c.x + Math.cos(aim) * reach, y: c.y + Math.sin(aim) * reach };
    let heading = SIDE_ANGLE[road.side];
    const pts: Vec2[] = [road.exit];
    // Straight out of the gate first, so the road leaves the fence square.
    pts.push({ x: road.exit.x + Math.cos(heading) * 350, y: road.exit.y + Math.sin(heading) * 350 });
    for (let i = 0; i < 60; i++) {
      const p = pts[pts.length - 1] ?? road.exit;
      if (Math.hypot(target.x - p.x, target.y - p.y) < WORLD.trunkStep) break;
      const want = Math.atan2(target.y - p.y, target.x - p.x);
      heading += Math.max(-0.32, Math.min(0.32, angleDiff(want, heading))) + rng.range(-0.16, 0.16);
      let nx = p.x + Math.cos(heading) * WORLD.trunkStep;
      let ny = p.y + Math.sin(heading) * WORLD.trunkStep;
      if (!this.inSector(road, nx, ny, WORLD.sectorInset)) {
        heading = want;
        nx = p.x + Math.cos(heading) * WORLD.trunkStep;
        ny = p.y + Math.sin(heading) * WORLD.trunkStep;
      }
      if (!this.inBounds(nx, ny)) break;
      pts.push({ x: nx, y: ny });
    }
    const along: number[] = [0];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      along.push((along[i - 1] ?? 0) + (a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0));
    }
    const last = pts.length - 1;
    const first = (pred: (i: number) => boolean, from: number, fallback: number): number => {
      for (let i = from; i <= last; i++) if (pred(i)) return i;
      return fallback;
    };
    const at = (i: number): Vec2 => pts[i] ?? road.exit;
    const hub = Math.max(2, first((i) => Math.hypot(at(i).x - c.x, at(i).y - c.y) >= WORLD.hubRadius, 1, Math.min(2, last)));
    const beyond = (along[last] ?? 0) - (along[hub] ?? 0);
    const mark = (f: number, from: number): number => first((i) => (along[i] ?? 0) >= (along[hub] ?? 0) + f * beyond, from, last);
    const gate = Math.min(last - 1, Math.max(hub + 2, mark(0.5, hub)));
    const inner = road.regions[0] ?? 'thornwood';
    const outer = road.regions[1] ?? inner;
    // Ids by region, not by gate side: a town edit that moves a gate keeps the waypoints saves hold.
    const gateId = `${inner}-gate`;

    const ids: number[] = [];
    let prev: MutableNode = root;
    for (let i = 0; i <= last; i++) {
      const p = at(i);
      const region = i < hub ? HOME_REGION : i < gate ? inner : outer;
      const node = this.addNode(p.x, p.y, prev, region, k, true, i > gate ? gateId : null, i > 0);
      ids.push(node.id);
      prev = node;
    }
    const idAt = (i: number): number => ids[Math.max(0, Math.min(last, i))] ?? root.id;
    const fork = Math.min(gate - 1, Math.max(hub + 1, mark(0.22, hub)));
    const innerName = ZONES[inner].name;
    const outerName = outer === inner ? `Deep ${innerName}` : ZONES[outer].name;
    waypoints.push({ id: `${inner}-1`, name: innerName, node: idAt(hub), region: inner });
    waypoints.push({ id: `${inner}-2`, name: `${innerName} Crossroads`, node: idAt(fork), region: inner });
    waypoints.push({ id: outer === inner ? `${inner}-3` : `${outer}-1`, name: outerName, node: idAt(gate + 1), region: outer });
    const g = at(gate);
    const after = at(gate + 1);
    gates.push({ id: gateId, node: idAt(gate), road: k, region: outer, angle: Math.atan2(after.y - g.y, after.x - g.x) });
    this.forks.set(k, { spur: first((i) => (along[i] ?? 0) >= 550, 1, 1), hub, fork, gate, late: Math.min(last - 1, Math.max(gate + 1, mark(0.75, gate))) });
    return ids;
  }

  /** Trunk indices where each road branches, worked out with the trunk. */
  private readonly forks = new Map<number, { spur: number; hub: number; fork: number; gate: number; late: number }>();

  private branches(k: number, road: PlanRoad, trunk: readonly number[]): void {
    const rng = Rng.stream(this.seed, `world:branches:${k}`);
    const f = this.forks.get(k);
    if (!f) return;
    const node = (i: number): MutableNode | undefined => this.list[trunk[i] ?? -1];
    const headingAt = (i: number): number => {
      const a = node(i - 1) ?? node(i);
      const b = node(i + 1) ?? node(i);
      return a && b ? Math.atan2(b.y - a.y, b.x - a.x) : road.angle;
    };
    const grow = (i: number, side: number, steps: number, spur: boolean): number[] => {
      const root = node(i);
      if (!root) return [];
      return this.branch(k, road, root, headingAt(i) + side * rng.range(0.85, 1.2), steps, spur, rng);
    };
    // Short spurs in the home region, one to each side, for the first fights out of town.
    grow(f.spur, 1, rng.int(3, 4), true);
    grow(f.spur, -1, rng.int(3, 4), true);
    const forked: number[][] = [];
    // Out along the edges of the sector from the region's entrance, then the forks proper.
    forked.push(grow(f.hub, 1, rng.int(4, 6), false), grow(f.hub, -1, rng.int(4, 6), false));
    forked.push(grow(f.fork, 1, rng.int(4, 7), false), grow(f.fork, -1, rng.int(4, 7), false));
    const mid = Math.round((f.fork + f.gate) / 2);
    if (mid > f.fork && mid < f.gate) forked.push(grow(mid, rng.next() < 0.5 ? 1 : -1, rng.int(4, 6), false));
    forked.push(grow(f.late, 1, rng.int(4, 6), false), grow(f.late, -1, rng.int(4, 6), false));
    // Side valleys off the longer branches.
    for (const b of forked) {
      if (b.length < 4 || rng.next() > 0.8) continue;
      const from = this.list[b[2] ?? -1];
      const to = this.list[b[3] ?? -1];
      if (!from || !to) continue;
      const h = Math.atan2(to.y - from.y, to.x - from.x);
      this.branch(k, road, from, h + (rng.next() < 0.5 ? 1 : -1) * rng.range(0.8, 1.1), rng.int(2, 3), false, rng);
    }
  }

  /**
   * One branch, a step at a time from `root`, stopping where it would leave the sector or the map,
   * come back into the home region (or, for a spur, leave it), or crowd a road it does not belong to.
   */
  private branch(k: number, road: PlanRoad, root: MutableNode, heading: number, steps: number, spur: boolean, rng: Rng): number[] {
    const c = this.centre;
    const out: number[] = [];
    const own = new Set<number>([root.id]);
    let prev = root;
    let h = heading;
    for (let s = 1; s <= steps; s++) {
      let placed: Vec2 | null = null;
      for (const turn of [0, 0.4, -0.4]) {
        const hh = h + turn + rng.range(-0.25, 0.25);
        const x = prev.x + Math.cos(hh) * WORLD.branchStep;
        const y = prev.y + Math.sin(hh) * WORLD.branchStep;
        if (!this.inBounds(x, y) || !this.inSector(road, x, y, WORLD.sectorInset)) continue;
        const r = Math.hypot(x - c.x, y - c.y);
        if (spur ? r > WORLD.hubRadius + 400 || this.nearTown(x, y, 380) : r < WORLD.hubRadius - 100) continue;
        if (this.crowded(prev, x, y, own, s)) continue;
        placed = { x, y };
        h = hh;
        break;
      }
      if (!placed) break;
      const n = this.addNode(placed.x, placed.y, prev, root.region, k, false, root.behind);
      own.add(n.id);
      out.push(n.id);
      prev = n;
    }
    return out;
  }

  private nearTown(x: number, y: number, pad: number): boolean {
    const t = this.town;
    return x >= t.x - pad && y >= t.y - pad && x <= t.x + t.w + pad && y <= t.y + t.h + pad;
  }

  /**
   * Whether a new step from `from` to (x, y) comes within the road gap of a road that is not its own.
   * Near its root a branch is allowed close to the road it leaves, and gains clearance as it goes.
   */
  private crowded(from: MutableNode, x: number, y: number, own: ReadonlySet<number>, step: number): boolean {
    const gap = step <= 2 ? WORLD.roadGap * 0.55 : WORLD.roadGap;
    for (const e of this.edgeList) {
      if (own.has(e.a) || own.has(e.b)) continue;
      // The trunk edges either side of the branch's root are where it leaves from.
      if (step <= 2 && (e.a === from.parent || e.b === from.parent)) continue;
      if (distToSegment(x, y, e.ax, e.ay, e.bx, e.by) < gap) return true;
      // The new segment's middle, so a step cannot cut across a road between two clear ends.
      if (distToSegment((x + from.x) / 2, (y + from.y) / 2, e.ax, e.ay, e.bx, e.by) < gap * 0.6) return true;
    }
    return false;
  }

  /** Dead ends get the region's boss, its dungeon entrances, rares and chests; side valleys get camps and ruins. */
  private placeSpots(ends: readonly MutableNode[]): PlanSpot[] {
    const rng = Rng.stream(this.seed, 'world:spots');
    const spots: PlanSpot[] = [];
    const regions = [HOME_REGION, ...this.roads.flatMap((r) => r.regions)].filter((r, i, all) => all.indexOf(r) === i);
    const beyond = (n: MutableNode, d: number): Vec2 => {
      const p = n.parent === null ? undefined : this.list[n.parent];
      const a = p ? Math.atan2(n.y - p.y, n.x - p.x) : 0;
      return { x: n.x + Math.cos(a) * d, y: n.y + Math.sin(a) * d };
    };
    const beside = (n: MutableNode, d: number, side: number): Vec2 => {
      const p = n.parent === null ? undefined : this.list[n.parent];
      const a = (p ? Math.atan2(n.y - p.y, n.x - p.x) : 0) + (side * Math.PI) / 2;
      return { x: n.x + Math.cos(a) * d, y: n.y + Math.sin(a) * d };
    };
    const push = (kind: SpotKind, at: Vec2, n: MutableNode): void => {
      spots.push({ kind, x: at.x, y: at.y, node: n.id, region: n.region });
    };
    for (const region of regions) {
      const here = ends.filter((n) => n.region === region).sort((a, b) => b.depth - a.depth || a.id - b.id);
      const [deepest, ...rest] = here;
      if (deepest) push('boss', beyond(deepest, 160), deepest);
      // Shuffled, so dungeons are not always on the deepest of the rest.
      for (let i = rest.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        const a = rest[i];
        const b = rest[j];
        if (a && b) {
          rest[i] = b;
          rest[j] = a;
        }
      }
      const dungeons = region === HOME_REGION ? 1 : 2;
      for (const [i, n] of rest.entries()) push(i < dungeons ? 'dungeon' : rng.next() < 0.5 ? 'rare' : 'chest', i < dungeons ? beyond(n, 60) : beyond(n, 130), n);
      const mids = this.list.filter((n) => n.region === region && n.parent !== null && n.children.length === 1 && Math.hypot(n.x - this.centre.x, n.y - this.centre.y) > 1300);
      const pick = (kind: 'camp' | 'ruin', count: number, near: [number, number], spacing: number): void => {
        const pool = [...mids];
        for (let placed = 0, tries = 0; placed < count && pool.length > 0 && tries < 60; tries++) {
          const n = pool.splice(rng.int(0, pool.length - 1), 1)[0];
          if (!n) break;
          const at = beside(n, rng.range(near[0], near[1]), rng.next() < 0.5 ? 1 : -1);
          if (!this.inBounds(at.x, at.y) || this.nearTown(at.x, at.y, 600)) continue;
          if (spots.some((s) => Math.hypot(s.x - at.x, s.y - at.y) < (s.kind === kind ? spacing : 650))) continue;
          push(kind, at, n);
          placed++;
        }
      };
      pick('camp', region === HOME_REGION ? 5 : 4, [300, 420], 1100);
      pick('ruin', region === HOME_REGION ? 1 : 2, [560, 720], 1500);
    }
    return spots;
  }

  private regionTable(): Map<ZoneId, PlanRegion> {
    const out = new Map<ZoneId, PlanRegion>();
    const ids = [HOME_REGION, ...this.roads.flatMap((r) => r.regions)].filter((r, i, all) => all.indexOf(r) === i);
    for (const id of ids) {
      const levels = this.list.filter((n) => n.region === id && n.road >= 0).map((n) => this.levelOf(n.depth, n.road));
      const road = this.roads.findIndex((r) => r.regions.includes(id));
      out.set(id, { id, def: ZONES[id], road: id === HOME_REGION || road < 0 ? null : road, levels: [Math.min(...levels), Math.max(...levels)] });
    }
    return out;
  }

  /** The edges that can be nearest to a point of lookup cell `i`. */
  private candidates(i: number): Int32Array {
    const hit = this.cellEdges[i];
    if (hit) return hit;
    const cx = ((i % this.cols) + 0.5) * CELL;
    const cy = (Math.floor(i / this.cols) + 0.5) * CELL;
    const d = this.edgeList.map((e) => distToSegment(cx, cy, e.ax, e.ay, e.bx, e.by));
    const best = Math.min(...d);
    // Any point of the cell is within half a diagonal of its centre, so its nearest edge is within this.
    const limit = best + CELL * Math.SQRT2;
    const keep: number[] = [];
    for (const [j, dj] of d.entries()) if (dj <= limit) keep.push(j);
    const out = Int32Array.from(keep);
    this.cellEdges[i] = out;
    return out;
  }

  /** The road nearest a point: which edge, how far along it (0 to 1) and how far from it. Ties go to the earlier edge. */
  nearest(x: number, y: number): { edge: WorldEdge; t: number; d: number } | null {
    if (this.edgeList.length === 0) return null;
    const cx = Math.max(0, Math.min(this.cols - 1, Math.floor(x / CELL)));
    const cy = Math.max(0, Math.min(this.rows - 1, Math.floor(y / CELL)));
    let best: WorldEdge | null = null;
    let bestD = Infinity;
    let bestT = 0;
    for (const j of this.candidates(cy * this.cols + cx)) {
      const e = this.edgeList[j];
      if (!e) continue;
      const dx = e.bx - e.ax;
      const dy = e.by - e.ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - e.ax) * dx + (y - e.ay) * dy) / len2));
      const d = Math.hypot(x - (e.ax + dx * t), y - (e.ay + dy * t));
      if (d < bestD) {
        best = e;
        bestD = d;
        bestT = t;
      }
    }
    return best ? { edge: best, t: bestT, d: bestD } : null;
  }

  private inTown(x: number, y: number): boolean {
    return this.nearTown(x, y, 0);
  }

  /** The region a spot belongs to: the town's for the town, otherwise its nearest road's. */
  regionAt(x: number, y: number): ZoneId {
    if (this.inTown(x, y)) return HOME_REGION;
    return this.nearest(x, y)?.edge.region ?? HOME_REGION;
  }

  /** Distance from town: along the roads to the nearest road, plus a share of the way off it. */
  distanceAt(x: number, y: number): number {
    if (this.inTown(x, y)) return 0;
    const n = this.nearest(x, y);
    return n ? n.edge.depthA + n.t * n.edge.length + WORLD.offRoad * n.d : 0;
  }

  /** 0 at the town gates, 1 at the farthest branch end of the nearest road's tree and beyond. */
  progressAt(x: number, y: number): number {
    if (this.inTown(x, y)) return 0;
    const n = this.nearest(x, y);
    return n ? Math.min(1, this.distanceAt(x, y) / (this.roadDepth[n.edge.road] ?? 1)) : 0;
  }

  /** The monster level at `distance` from town along road `road`. */
  levelOf(distance: number, road: number): number {
    const [lo, hi] = WORLD.levels;
    const t = Math.min(1, Math.max(0, distance / (this.roadDepth[road] ?? 1)));
    return Math.round(lo + (hi - lo) * t ** WORLD.levelCurve);
  }

  levelAt(x: number, y: number): number {
    const [lo, hi] = WORLD.levels;
    return Math.round(lo + (hi - lo) * this.progressAt(x, y) ** WORLD.levelCurve);
  }

  biomeAt(x: number, y: number): Biome {
    return ZONES[this.regionAt(x, y)].biome;
  }

  /** How many packs a spot gets relative to the rest: more further out, fewer far from any road. */
  packWeight(x: number, y: number): number {
    const n = this.nearest(x, y);
    const d = n?.d ?? 0;
    const nearRoad = d <= 1100 ? 1 : Math.max(0.3, 1 - (d - 1100) / 1600);
    return (0.7 + 0.7 * this.progressAt(x, y)) * nearRoad;
  }

  /** Pack size multiplier: packs grow by half again from the town to the far ends. */
  packScale(x: number, y: number): number {
    return 0.85 + 0.5 * this.progressAt(x, y);
  }

  /** How many forests a spot gets relative to the rest: by the region's biome, and thicker away from the roads. */
  forestWeight(x: number, y: number): number {
    const n = this.nearest(x, y);
    const d = n?.d ?? 0;
    const off = d < 300 ? 0.2 : Math.min(2, 0.6 + (d - 300) / 1000);
    return FOREST_BY_BIOME[this.biomeAt(x, y)] * off;
  }

  /** A waypoint's spot on the map. */
  node(id: number): WorldNode | undefined {
    return this.nodes[id];
  }
}

const FOREST_BY_BIOME: Record<Biome, number> = { forest: 2.2, marsh: 1.1, meadow: 1, ruins: 0.6, crypt: 0.6, cave: 0.5, desert: 0.25 };

/** Waypoint ids are short words, with a number after a dash for the world's: the old zone ids and `steppe-2` alike. */
export function isWaypointId(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 24 && /^[a-z]+(-[0-9a-z]+)?$/.test(v);
}
