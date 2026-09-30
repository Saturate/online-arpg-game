/**
 * Tick cost per room with and without monster sleep (world streaming step 1):
 *
 *   pnpm bench:streaming            # both modes
 *   pnpm bench:streaming --only on  # or --only off
 *
 * Runs a big generated zone (3x today's zone in each direction) with 1, 4 and 8 players spread out,
 * then every current zone with one player at its spawn. Players are in god mode and walk small
 * circles without casting, so the monsters around them wake, chase and fight the whole time.
 * "step" is `Simulation.step` alone; "room" adds what the server does after it every tick
 * (serialising entities and one interest-filtered snapshot per player).
 */
import { CLASS_IDS, NET, serializeEntities, SIM, Simulation, snapshotFor, ZONE_IDS, ZONE_SIZE, type ZoneId } from '../packages/shared/src/index.js';
import { setStreaming, streamingStats } from '../packages/shared/src/sim/streaming.js';

const WARMUP_TICKS = 60;
const MEASURE_TICKS = 600;
const BIG_SCALE = 3;

interface Result {
  label: string;
  mode: 'on' | 'off';
  monsters: number;
  asleep: number;
  step: { median: number; p95: number };
  room: { median: number; p95: number };
}

function stats(samples: number[]): { median: number; p95: number } {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  return { median: at(0.5), p95: at(0.95) };
}

function run(label: string, zone: ZoneId, seed: number, players: number, streaming: boolean, spread: boolean): Result {
  const sim = new Simulation(seed, { kind: 'zone', zone, seed });
  setStreaming(sim, streaming);
  const ids: number[] = [];
  for (let i = 0; i < players; i++) {
    // Spread players over a grid of the map so each one is its own island of awake chunks.
    const cols = Math.ceil(Math.sqrt(players));
    const rows = Math.ceil(players / cols);
    const at = spread
      ? { x: (sim.map.width * ((i % cols) + 0.5)) / cols, y: (sim.map.height * (Math.floor(i / cols) + 0.5)) / rows }
      : undefined;
    const id = sim.addPlayer(`bench${i}`, CLASS_IDS[i % CLASS_IDS.length] ?? 'warrior', `Bench ${i}`, undefined, at);
    const p = sim.world.player.get(id);
    if (p) p.god = true;
    ids.push(id);
  }
  const stepMs: number[] = [];
  const roomMs: number[] = [];
  let seq = 0;
  for (let t = 0; t < WARMUP_TICKS + MEASURE_TICKS; t++) {
    const a = (t / SIM.tickRate) * 0.8;
    seq++;
    for (const [k, id] of ids.entries()) sim.applyInput(id, { seq, moveDir: { x: Math.cos(a + k), y: Math.sin(a + k) }, aimAngle: a, buttons: 0 });
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
  return { label, mode: streaming ? 'on' : 'off', monsters: sim.world.enemy.size, asleep: streamingStats(sim).asleep, step: stats(stepMs), room: stats(roomMs) };
}

function fmt(n: number): string {
  return n.toFixed(3).padStart(7);
}

function print(rows: Result[]): void {
  console.log('scenario                        mode  monsters asleep  step med  step p95  room med  room p95  (ms)');
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(31)} ${r.mode.padEnd(4)} ${String(r.monsters).padStart(8)} ${String(r.asleep).padStart(6)} ${fmt(r.step.median)}   ${fmt(r.step.p95)}   ${fmt(r.room.median)}   ${fmt(r.room.p95)}`,
    );
  }
}

const onlyArg = process.argv.indexOf('--only');
const only = onlyArg >= 0 ? process.argv[onlyArg + 1] : undefined;
const modes = only === 'on' ? [true] : only === 'off' ? [false] : [false, true];

const rows: Result[] = [];
for (const zone of ZONE_IDS) {
  for (const streaming of modes) rows.push(run(`${zone} (1 player at spawn)`, zone, 1337, 1, streaming, false));
}
// Zone size is read when a zone is generated, so growing it here gives a big zone with packs scaled
// to its area. Done after the normal zones, whose cached maps keep today's size.
Object.assign(ZONE_SIZE, { width: ZONE_SIZE.width * BIG_SCALE, height: ZONE_SIZE.height * BIG_SCALE });
for (const players of [1, 4, 8]) {
  for (const streaming of modes) rows.push(run(`big steppe, ${players} spread`, 'steppe', 4242, players, streaming, true));
}
print(rows);
