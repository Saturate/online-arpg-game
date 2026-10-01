/**
 * World streaming benches (docs/features/world-streaming.md):
 *
 *   NODE_OPTIONS=--expose-gc pnpm bench:streaming             # every section
 *   NODE_OPTIONS=--expose-gc pnpm bench:streaming create walk  # some of them
 *
 * create  Room creation for today's zones and zones 4x and 9x the area (2x and 3x the width and
 *         height): the time to construct the room, and the heap it keeps (with --expose-gc), then
 *         the same for a player arriving and 20 ticks after. "whole" builds every chunk and spawns
 *         every pack at creation, as rooms did before step 3; "chunks" is the live behaviour.
 * walk    Tick cost with players walking across a zone west to east at hero speed (god mode, no
 *         casting), so chunks are built and packs spawn as they go and the monsters met chase them.
 * sleep   Step 1's comparison: every pack spawned, sleep off and on, one player at each zone's
 *         spawn, then a 9x zone with 1, 4 and 8 players spread out, walking small circles.
 *
 * "step" is `Simulation.step`; "room" adds what the server does after it every tick (serialising
 * entities and one interest-filtered snapshot per player). Run against an older checkout (copy this
 * file into its scripts/) to get the numbers from before step 3: it only has the "whole" mode.
 */
import { execFileSync } from 'node:child_process';
import { CLASS_IDS, NET, serializeEntities, SIM, Simulation, snapshotFor, ZONE_IDS, ZONE_SIZE, type MapDescriptor, type ZoneId } from '../packages/shared/src/index.js';
import * as streaming from '../packages/shared/src/sim/streaming.js';

const BASE = { width: ZONE_SIZE.width, height: ZONE_SIZE.height };
/** Seeds no other run uses, since generated maps are cached by descriptor. */
let nextSeed = 600_000;

/** Step 3 exists in this checkout (lazy chunks), or this is an older one that builds zones whole. */
const lazyChunks = 'spawnEverywhere' in streaming;

type Mode = 'whole' | 'chunks';

function setScale(scale: number): void {
  Object.assign(ZONE_SIZE, { width: BASE.width * scale, height: BASE.height * scale });
}

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

/** What a room built whole holds from the start: every chunk built, every pack spawned. */
function buildWhole(sim: Simulation): void {
  if (!lazyChunks) return;
  streaming.spawnEverywhere?.(sim);
  sim.map.ensureAll?.();
}

function newRoom(zone: ZoneId, mode: Mode, seed = nextSeed++): Simulation {
  const desc: MapDescriptor = { kind: 'zone', zone, seed };
  const sim = new Simulation(seed, desc);
  if (mode === 'whole') buildWhole(sim);
  return sim;
}

function fmt(n: number, w = 7, d = 2): string {
  return n.toFixed(d).padStart(w);
}

/**
 * One case of the creation bench, in a process of its own: generated maps are cached by descriptor
 * and the cache drops old entries as it fills, which would free memory in the middle of a measure.
 */
function createOne(zone: ZoneId, scale: number, mode: Mode): string {
  const ROOMS = 4;
  setScale(scale);
  // A warm-up room, so module and JIT costs are not counted.
  newRoom(zone, mode);
  gc();
  const rooms: Simulation[] = [];
  let createMs = 0;
  const h0 = heapMb();
  for (let i = 0; i < ROOMS; i++) {
    const t0 = performance.now();
    rooms.push(newRoom(zone, mode));
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
  return `${zone.padEnd(10)} x${String(scale * scale).padEnd(3)} ${size.padEnd(13)} ${mode.padEnd(6)} ${fmt(createMs / ROOMS, 9)} ${fmt((h1 - h0) / ROOMS, 8)} | ${fmt(arriveMs / ROOMS, 18)} ${fmt((h2 - h0) / ROOMS, 8)} | ${String(last?.world.enemy.size ?? 0).padStart(8)} ${String(last?.map.builtChunks ?? 0).padStart(6)} ${String(last?.zone?.generatedChunks ?? 0).padStart(10)}`;
}

function create(): void {
  const modes: Mode[] = lazyChunks ? ['whole', 'chunks'] : ['whole'];
  console.log(`\nRoom creation, mean of 4 rooms each${typeof Reflect.get(globalThis, 'gc') === 'function' ? '' : ' (heap needs NODE_OPTIONS=--expose-gc)'}`);
  console.log('zone              size          mode    create ms  heap MB | arrive+20 ticks ms  heap MB | monsters  built  generated');
  const cases: [ZoneId, number][] = [...ZONE_IDS.map((z): [ZoneId, number] => [z, 1]), ['thornwood', 2], ['thornwood', 3], ['steppe', 3]];
  for (const [zone, scale] of cases) {
    for (const mode of modes) {
      const script = process.argv[1] ?? '';
      const out = execFileSync(process.execPath, [...process.execArgv, script, 'create-one', zone, String(scale), mode], { encoding: 'utf8' });
      process.stdout.write(out);
    }
  }
}

function walk(): void {
  // By chunk first: both runs share the cached map, which the whole run then finishes building.
  const modes: Mode[] = lazyChunks ? ['chunks', 'whole'] : ['whole'];
  // Warm the JIT first, so the first row is not paying for it.
  const warm = newRoom('steppe', 'chunks');
  warm.addPlayer('warm', 'mage', 'Warm');
  for (let t = 0; t < 300; t++) warm.step();
  console.log('\nWalking west to east across a zone at 220 units a second (god mode, no casting)');
  console.log('zone              players mode    ticks  step med   p95    max | room med   p95    max | monsters at end  built  generated');
  for (const [zone, scale] of [
    ['steppe', 1],
    ['thornwood', 2],
    ['thornwood', 3],
  ] as const) {
    for (const players of [1, 4]) {
      const seed = nextSeed++;
      for (const mode of modes) {
        setScale(scale);
        const sim = newRoom(zone, mode, seed);
        const ids: number[] = [];
        for (let i = 0; i < players; i++) {
          // Lanes spread over the height, starting at the west edge.
          const y = (sim.map.height * (i + 0.5)) / players;
          const id = sim.addPlayer(`bench${i}`, CLASS_IDS[i % CLASS_IDS.length] ?? 'warrior', `Bench ${i}`, undefined, { x: 300, y });
          const p = sim.world.player.get(id);
          if (p) p.god = true;
          ids.push(id);
        }
        const stepMs: number[] = [];
        const roomMs: number[] = [];
        const perTick = 220 / SIM.tickRate;
        const ticks = Math.floor((sim.map.width - 600) / perTick);
        for (let t = 0; t < ticks; t++) {
          // Moved along the lane rather than steered, and without input (whose movement would push
          // them back out of a river every tick), so nothing stops the walk.
          for (const id of ids) {
            const pos = sim.world.position.get(id);
            if (pos) pos.x = Math.min(sim.map.width - 300, pos.x + perTick);
          }
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
        const st = stats(stepMs);
        const rm = stats(roomMs);
        console.log(
          `${zone.padEnd(10)} x${String(scale * scale).padEnd(3)} ${String(players).padStart(7)} ${mode.padEnd(6)} ${String(ticks).padStart(5)} ${fmt(st.median, 8, 3)} ${fmt(st.p95, 6, 3)} ${fmt(st.max, 6, 1)} | ${fmt(rm.median, 8, 3)} ${fmt(rm.p95, 6, 3)} ${fmt(rm.max, 6, 1)} | ${String(sim.world.enemy.size).padStart(15)} ${String(sim.map.builtChunks ?? 0).padStart(6)} ${String(sim.zone?.generatedChunks ?? 0).padStart(10)}`,
        );
      }
    }
  }
  setScale(1);
}

const WARMUP_TICKS = 60;
const MEASURE_TICKS = 600;

function sleepRun(label: string, zone: ZoneId, seed: number, players: number, sleep: boolean, spread: boolean): string {
  const sim = newRoom(zone, 'whole', seed);
  streaming.setStreaming(sim, sleep);
  const ids: number[] = [];
  for (let i = 0; i < players; i++) {
    // Spread players over a grid of the map so each one is its own island of awake chunks.
    const cols = Math.ceil(Math.sqrt(players));
    const rows = Math.ceil(players / cols);
    const at = spread ? { x: (sim.map.width * ((i % cols) + 0.5)) / cols, y: (sim.map.height * (Math.floor(i / cols) + 0.5)) / rows } : undefined;
    const id = sim.addPlayer(`bench${i}`, CLASS_IDS[i % CLASS_IDS.length] ?? 'warrior', `Bench ${i}`, undefined, at);
    const p = sim.world.player.get(id);
    if (p) p.god = true;
    ids.push(id);
  }
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
  return `${label.padEnd(31)} ${(sleep ? 'on' : 'off').padEnd(4)} ${String(sim.world.enemy.size).padStart(8)} ${String(streaming.streamingStats(sim).asleep).padStart(6)} ${fmt(st.median, 9, 3)} ${fmt(st.p95, 9, 3)} ${fmt(rm.median, 9, 3)} ${fmt(rm.p95, 9, 3)}`;
}

function sleep(): void {
  console.log('\nSleep off and on, every pack spawned');
  console.log('scenario                        mode  monsters asleep  step med  step p95  room med  room p95  (ms)');
  // The same seed with sleep off and on: the map is cached, so the two runs share it.
  for (const zone of ZONE_IDS) {
    const seed = nextSeed++;
    for (const on of [false, true]) console.log(sleepRun(`${zone} (1 player at spawn)`, zone, seed, 1, on, false));
  }
  setScale(3);
  for (const players of [1, 4, 8]) {
    const seed = nextSeed++;
    for (const on of [false, true]) console.log(sleepRun(`9x steppe, ${players} spread`, 'steppe', seed, players, on, true));
  }
  setScale(1);
}

const asked = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (asked[0] === 'create-one') {
  const zone = ZONE_IDS.find((z) => z === asked[1]) ?? 'steppe';
  console.log(createOne(zone, Number(asked[2] ?? 1), asked[3] === 'chunks' ? 'chunks' : 'whole'));
  process.exit(0);
}
const want = (s: string): boolean => asked.length === 0 || asked.includes(s);
if (want('create')) create();
if (want('walk')) walk();
if (want('sleep')) sleep();
