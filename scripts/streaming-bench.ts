/**
 * World streaming benches (docs/features/world-streaming.md, docs/features/world-map.md):
 *
 *   NODE_OPTIONS=--expose-gc pnpm bench:streaming               # every section
 *   NODE_OPTIONS=--expose-gc pnpm bench:streaming create walk    # some of them
 *
 * create  Room creation for the world and a standalone Wilds: the time to construct the room and
 *         the heap it keeps (with --expose-gc), then the same for a player arriving and 20 ticks
 *         after. "whole" builds every chunk and spawns every pack at creation; "chunks" is the live
 *         behaviour.
 * walk    Players walking from the town out along the roads to branch ends at hero speed (god mode,
 *         no casting), so chunks are built and packs spawn as they go and the monsters met chase.
 * spread  1, 4 and 8 players standing apart over the world (at waypoints and branch ends), walking
 *         small circles, with sleep on: the tick a busy world copy costs, and the monsters alive.
 *
 * "step" is `Simulation.step`; "room" adds what the server does after it every tick (serialising
 * entities and one interest-filtered snapshot per player).
 *
 * WORLD_GEN='{"size":16000,"packs":450}' builds every world on those generation numbers instead of
 * the defaults (world-map.md, "Generation settings").
 */
import { execFileSync } from 'node:child_process';
import { CLASS_IDS, isWorldGenValues, NET, resolveWorldGen, serializeEntities, SIM, Simulation, snapshotFor, worldGenKey, worldGenOverrides, type MapDescriptor, type Vec2, type WorldGenValues, type WorldPlan } from '../packages/shared/src/index.js';
import * as streaming from '../packages/shared/src/sim/streaming.js';

/** Seeds no other run uses, since generated maps are cached by descriptor. */
let nextSeed = 600_000;

type Mode = 'whole' | 'chunks';
type Kind = 'world' | 'wilds';

function stats(samples: number[]): { median: number; p95: number; max: number } {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  return { median: at(0.5), p95: at(0.95), max: s[s.length - 1] ?? 0 };
}

function gc(): void {
  const g: unknown = Reflect.get(globalThis, 'gc');
  if (typeof g === 'function') {
    g();
    g();
  }
}

function heapMb(): number {
  return process.memoryUsage().heapUsed / 1e6;
}

function readGen(raw: string | undefined): WorldGenValues {
  if (raw === undefined || raw === '') return {};
  const v: unknown = JSON.parse(raw);
  if (!isWorldGenValues(v)) throw new Error('WORLD_GEN holds an unknown key or a number out of range');
  // Resolving puts back the numbers of a broken rule (a home region too big for the world).
  const gen = resolveWorldGen(v);
  if (worldGenKey(v) !== worldGenKey(gen)) throw new Error('WORLD_GEN breaks a rule between its numbers (levels or branch lengths out of order, a home region too big for the world)');
  return worldGenOverrides(gen);
}

const GEN = readGen(process.env.WORLD_GEN);

function newRoom(kind: Kind, mode: Mode, seed = nextSeed++): Simulation {
  const desc: MapDescriptor = kind === 'world' ? { kind, seed, gen: GEN } : { kind, seed };
  const sim = new Simulation(seed, desc);
  if (mode === 'whole') {
    streaming.spawnEverywhere(sim);
    sim.map.ensureAll();
  }
  return sim;
}

function planOf(sim: Simulation): WorldPlan {
  const plan = sim.zone?.plan;
  if (!plan) throw new Error('not the world');
  return plan;
}

function fmt(n: number, w = 7, d = 2): string {
  return n.toFixed(d).padStart(w);
}

/** One case of the creation bench, in a process of its own, so the map cache never frees memory mid-measure. */
function createOne(kind: Kind, mode: Mode): string {
  const ROOMS = 4;
  // A warm-up room, so module and JIT costs are not counted.
  newRoom(kind, mode);
  gc();
  const rooms: Simulation[] = [];
  let createMs = 0;
  const h0 = heapMb();
  for (let i = 0; i < ROOMS; i++) {
    const t0 = performance.now();
    rooms.push(newRoom(kind, mode));
    createMs += performance.now() - t0;
  }
  gc();
  const h1 = heapMb();
  let arriveMs = 0;
  for (const sim of rooms) {
    const t0 = performance.now();
    sim.addPlayer('bench', 'mage', 'Bench');
    for (let t = 0; t < 20; t++) sim.step();
    arriveMs += performance.now() - t0;
  }
  gc();
  const h2 = heapMb();
  const last = rooms[rooms.length - 1];
  const size = last ? `${last.map.width}x${last.map.height}` : '';
  return `${kind.padEnd(6)} ${size.padEnd(12)} ${mode.padEnd(6)} ${fmt(createMs / ROOMS, 9)} ${fmt((h1 - h0) / ROOMS, 8)} | ${fmt(arriveMs / ROOMS, 18)} ${fmt((h2 - h0) / ROOMS, 8)} | ${String(last?.world.enemy.size ?? 0).padStart(8)} ${String(last?.map.builtChunks ?? 0).padStart(6)} ${String(last?.zone?.generatedChunks ?? 0).padStart(10)}`;
}

function create(): void {
  console.log(`\nRoom creation, mean of 4 rooms each${typeof Reflect.get(globalThis, 'gc') === 'function' ? '' : ' (heap needs NODE_OPTIONS=--expose-gc)'}`);
  console.log('map    size         mode    create ms  heap MB | arrive+20 ticks ms  heap MB | monsters  built  generated');
  for (const kind of ['world', 'wilds'] as const) {
    for (const mode of ['whole', 'chunks'] as const) {
      const script = process.argv[1] ?? '';
      process.stdout.write(execFileSync(process.execPath, [...process.execArgv, script, 'create-one', kind, mode], { encoding: 'utf8' }));
    }
  }
}

/** Points from the town spawn along the roads to branch ends, one route per player: the deepest end of each road first, then others. */
function routes(sim: Simulation, players: number): Vec2[][] {
  const plan = planOf(sim);
  const ends = plan.nodes.filter((n) => n.children.length === 0 && n.parent !== null).sort((a, b) => b.depth - a.depth);
  const byRoad = [0, 1, 2].map((k) => ends.filter((n) => n.road === k));
  const order: typeof ends = [];
  for (let i = 0; order.length < ends.length; i++) {
    for (const list of byRoad) {
      const n = list[i];
      if (n) order.push(n);
    }
  }
  return Array.from({ length: players }, (_, i) => {
    const end = order[i % order.length];
    const chain: Vec2[] = [];
    for (let n = end; n && n.parent !== null; n = plan.node(n.parent)) chain.push({ x: n.x, y: n.y });
    return [sim.mapDef.spawn, ...chain.reverse()];
  });
}

function walk(): void {
  const warm = newRoom('world', 'chunks');
  warm.addPlayer('warm', 'mage', 'Warm');
  for (let t = 0; t < 300; t++) warm.step();
  console.log('\nWalking out of town along the roads to branch ends at 220 units a second (god mode, no casting, chunks)');
  console.log('players  ticks  step med   p95    max | room med   p95    max | monsters at end  built  generated  heap MB');
  for (const players of [1, 4, 8]) {
    gc();
    const h0 = heapMb();
    const sim = newRoom('world', 'chunks');
    const paths = routes(sim, players);
    const ids = paths.map((_, i) => {
      const id = sim.addPlayer(`bench${i}`, CLASS_IDS[i % CLASS_IDS.length] ?? 'warrior', `Bench ${i}`);
      const p = sim.world.player.get(id);
      if (p) p.god = true;
      return id;
    });
    const legs = paths.map(() => 1);
    const stepMs: number[] = [];
    const roomMs: number[] = [];
    const perTick = 220 / SIM.tickRate;
    let ticks = 0;
    for (; ticks < 60 * SIM.tickRate; ticks++) {
      let walking = false;
      // Moved along the road rather than steered, so nothing in the way stops the walk.
      for (const [i, id] of ids.entries()) {
        const pos = sim.world.position.get(id);
        const path = paths[i] ?? [];
        const leg = legs[i] ?? 1;
        const to = path[leg];
        if (!pos || !to) continue;
        walking = true;
        const d = Math.hypot(to.x - pos.x, to.y - pos.y);
        if (d <= perTick) {
          pos.x = to.x;
          pos.y = to.y;
          legs[i] = leg + 1;
        } else {
          pos.x += ((to.x - pos.x) / d) * perTick;
          pos.y += ((to.y - pos.y) / d) * perTick;
        }
      }
      if (!walking) break;
      const t0 = performance.now();
      sim.step();
      const t1 = performance.now();
      const entities = serializeEntities(sim);
      const events = sim.takeEvents();
      for (const id of ids) snapshotFor(sim, id, entities, events, NET.interestRadius, new Map());
      const t2 = performance.now();
      stepMs.push(t1 - t0);
      roomMs.push(t2 - t0);
    }
    gc();
    const st = stats(stepMs);
    const rm = stats(roomMs);
    console.log(
      `${String(players).padStart(7)} ${String(ticks).padStart(6)} ${fmt(st.median, 8, 3)} ${fmt(st.p95, 6, 3)} ${fmt(st.max, 6, 1)} | ${fmt(rm.median, 8, 3)} ${fmt(rm.p95, 6, 3)} ${fmt(rm.max, 6, 1)} | ${String(sim.world.enemy.size).padStart(15)} ${String(sim.map.builtChunks).padStart(6)} ${String(sim.zone?.generatedChunks ?? 0).padStart(10)} ${fmt(heapMb() - h0, 8)}`,
    );
  }
}

const WARMUP_TICKS = 60;
const MEASURE_TICKS = 600;

function spread(): void {
  console.log('\nPlayers spread over the world, walking small circles (sleep on, chunks), 600 ticks after 60 of warm-up');
  console.log('players  monsters  awake  asleep  step med  step p95  room med  room p95  (ms)');
  for (const players of [1, 4, 8]) {
    const sim = newRoom('world', 'chunks');
    const plan = planOf(sim);
    // At waypoints and the deepest branch ends, so each player is an island of awake chunks of their own.
    const spots: Vec2[] = [...(sim.mapDef.waypoints ?? []).filter((w) => w.id !== 'town'), ...plan.nodes.filter((n) => n.children.length === 0).sort((a, b) => b.depth - a.depth)];
    const picked: Vec2[] = [];
    for (const s of spots) if (picked.length < players && picked.every((p) => Math.hypot(p.x - s.x, p.y - s.y) > 2500)) picked.push(s);
    const ids = picked.map((at, i) => {
      const id = sim.addPlayer(`bench${i}`, CLASS_IDS[i % CLASS_IDS.length] ?? 'warrior', `Bench ${i}`, undefined, at);
      const p = sim.world.player.get(id);
      if (p) p.god = true;
      return id;
    });
    const stepMs: number[] = [];
    const roomMs: number[] = [];
    for (let t = 0; t < WARMUP_TICKS + MEASURE_TICKS; t++) {
      const a = (t / SIM.tickRate) * 0.8;
      for (const [k, id] of ids.entries()) sim.applyInput(id, { seq: t + 1, moveDir: { x: Math.cos(a + k), y: Math.sin(a + k) }, aimAngle: a, buttons: 0 });
      const t0 = performance.now();
      sim.step();
      const t1 = performance.now();
      const entities = serializeEntities(sim);
      const events = sim.takeEvents();
      for (const id of ids) snapshotFor(sim, id, entities, events, NET.interestRadius, new Map());
      const t2 = performance.now();
      if (t >= WARMUP_TICKS) {
        stepMs.push(t1 - t0);
        roomMs.push(t2 - t0);
      }
    }
    const st = stats(stepMs);
    const rm = stats(roomMs);
    const s = streaming.streamingStats(sim);
    console.log(`${String(ids.length).padStart(7)} ${String(sim.world.enemy.size).padStart(9)} ${String(sim.world.enemy.size - s.asleep).padStart(6)} ${String(s.asleep).padStart(7)} ${fmt(st.median, 9, 3)} ${fmt(st.p95, 9, 3)} ${fmt(rm.median, 9, 3)} ${fmt(rm.p95, 9, 3)}`);
  }
}

const asked = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (asked[0] === 'create-one') {
  console.log(createOne(asked[1] === 'wilds' ? 'wilds' : 'world', asked[2] === 'chunks' ? 'chunks' : 'whole'));
  process.exit(0);
}
const want = (s: string): boolean => asked.length === 0 || asked.includes(s);
if (want('create')) create();
if (want('walk')) walk();
if (want('spread')) spread();
