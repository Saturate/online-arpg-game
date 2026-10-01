import { describe, expect, it } from 'vitest';
import { DEFAULT_SERVER_SETTINGS, NET, parseSettingsPatch, rememberWorld, restoreWorld, SETTINGS_LIMITS, SIM, Simulation, STREAMING, type EntityId, type MapDescriptor } from '../src/index.js';
import { chestKey, openedChests } from '../src/sim/chests.js';
import { chunkAwake, chunkSpawnAt, setRespawnTimes, updateStreaming } from '../src/sim/streaming.js';

const WILDS_DESC: MapDescriptor = { kind: 'wilds', seed: 77 };
const PACK_MINUTES = 1;
const BOSS_MINUTES = 2;
const PACK_TICKS = PACK_MINUTES * 60 * SIM.tickRate;
const BOSS_TICKS = BOSS_MINUTES * 60 * SIM.tickRate;

function room(desc: MapDescriptor = WILDS_DESC, seed = 9): { sim: Simulation; pid: EntityId } {
  const sim = new Simulation(seed, desc);
  setRespawnTimes(sim, { respawnMinutes: PACK_MINUTES, bossRespawnMinutes: BOSS_MINUTES });
  const pid = sim.addPlayer('p', 'warrior', 'P');
  const p = sim.world.player.get(pid);
  if (p) p.god = true;
  return { sim, pid };
}

function moveTo(sim: Simulation, pid: EntityId, x: number, y: number): void {
  const pos = sim.world.position.get(pid);
  if (!pos) throw new Error('no player');
  pos.x = x;
  pos.y = y;
}

/** Game time passing without the monster systems, which these tests do not need: the streaming recompute alone. */
function advance(sim: Simulation, ticks: number): void {
  for (let t = 0; t < ticks; t += STREAMING.recomputeEveryTicks) {
    sim.tick += STREAMING.recomputeEveryTicks;
    updateStreaming(sim);
  }
}

function kill(sim: Simulation, ids: readonly EntityId[]): void {
  for (const id of ids) sim.world.destroy(id);
  sim.world.flushDestroyed();
}

/** The first chunk holding the kind of pack asked for, by its middle. */
function chunkWith(sim: Simulation, boss: boolean): { x: number; y: number } {
  const zone = sim.zone;
  if (!zone) throw new Error('not a generated zone');
  const size = STREAMING.chunkSize;
  for (let cy = 0; cy * size < sim.map.height; cy++) {
    for (let cx = 0; cx * size < sim.map.width; cx++) {
      if (zone.packs(cx, cy).some((p) => p.boss === boss)) return { x: (cx + 0.5) * size, y: (cy + 0.5) * size };
    }
  }
  throw new Error('no such chunk');
}

/** The map corner farthest from a point, well outside its wake range on these maps. */
function farFrom(sim: Simulation, at: { x: number; y: number }): { x: number; y: number } {
  const x = at.x < sim.map.width / 2 ? sim.map.width - 50 : 50;
  const y = at.y < sim.map.height / 2 ? sim.map.height - 50 : 50;
  return { x, y };
}

function describeMonster(sim: Simulation, id: EntityId): string {
  const e = sim.world.enemy.get(id);
  const q = sim.world.position.get(id);
  const h = sim.world.health.get(id);
  return JSON.stringify([e?.typeId, e?.level, e?.rare, e?.boss, e?.affixes, q?.x, q?.y, h?.maxLife]);
}

function spawnedAt(sim: Simulation, at: { x: number; y: number }): NonNullable<ReturnType<typeof chunkSpawnAt>> {
  const c = chunkSpawnAt(sim, at.x, at.y);
  if (!c) throw new Error('chunk not spawned');
  return c;
}

/** Sets a room up with a cleared chunk and the player walked off out of its wake range. */
function clearedAndLeft(desc: MapDescriptor = WILDS_DESC, seed = 9): { sim: Simulation; pid: EntityId; at: { x: number; y: number } } {
  const { sim, pid } = room(desc, seed);
  const at = chunkWith(sim, false);
  moveTo(sim, pid, at.x, at.y);
  advance(sim, 5);
  const c = spawnedAt(sim, at);
  expect(c.packs.length).toBeGreaterThan(0);
  kill(sim, c.packs);
  const away = farFrom(sim, at);
  moveTo(sim, pid, away.x, away.y);
  advance(sim, 5);
  expect(chunkAwake(sim, at.x, at.y)).toBe(false);
  return { sim, pid, at };
}

describe('respawn by inactivity', () => {
  it('never refills a chunk while someone stays in its wake range', () => {
    const { sim, pid } = room();
    const at = chunkWith(sim, false);
    moveTo(sim, pid, at.x, at.y);
    advance(sim, 5);
    const c = spawnedAt(sim, at);
    kill(sim, c.packs);
    // Walking about inside the wake range for longer than both timers.
    for (let i = 0; i < 8; i++) {
      moveTo(sim, pid, at.x + (i % 2 === 0 ? 900 : -900), at.y);
      advance(sim, BOSS_TICKS / 4);
    }
    expect(spawnedAt(sim, at).respawns.packs).toBe(0);
    expect(spawnedAt(sim, at).packs.some((id) => sim.world.isAlive(id))).toBe(false);
  });

  it('refills a cleared chunk once nobody has been near for the respawn time, out of view', () => {
    const { sim, pid, at } = clearedAndLeft();
    const before = spawnedAt(sim, at).packs.length;
    advance(sim, PACK_TICKS - 20);
    expect(spawnedAt(sim, at).respawns.packs).toBe(0);
    advance(sim, 40);
    const c = spawnedAt(sim, at);
    expect(c.respawns.packs).toBe(1);
    expect(c.packs.length).toBe(before);
    const me = sim.world.position.get(pid);
    if (!me) throw new Error('no player');
    for (const id of c.packs) {
      expect(sim.world.isAlive(id)).toBe(true);
      const q = sim.world.position.get(id);
      if (!q) throw new Error('no position');
      expect(Math.hypot(q.x - me.x, q.y - me.y)).toBeGreaterThan(NET.interestRadius + 500);
      expect(sim.world.enemy.get(id)?.aggro).toBe(false);
    }
  });

  it('starts the wait again when someone comes back before it is up', () => {
    const { sim, pid, at } = clearedAndLeft();
    advance(sim, PACK_TICKS / 2);
    moveTo(sim, pid, at.x, at.y);
    advance(sim, 20);
    const away = farFrom(sim, at);
    moveTo(sim, pid, away.x, away.y);
    advance(sim, PACK_TICKS - 40);
    expect(spawnedAt(sim, at).respawns.packs).toBe(0);
    advance(sim, 60);
    expect(spawnedAt(sim, at).respawns.packs).toBe(1);
  });

  it('leaves a chunk nobody killed anything in as it stands', () => {
    const { sim, pid } = room();
    const at = chunkWith(sim, false);
    moveTo(sim, pid, at.x, at.y);
    advance(sim, 5);
    const ids = [...spawnedAt(sim, at).packs];
    const away = farFrom(sim, at);
    moveTo(sim, pid, away.x, away.y);
    advance(sim, PACK_TICKS * 2);
    expect(spawnedAt(sim, at).respawns.packs).toBe(0);
    expect(spawnedAt(sim, at).packs).toEqual(ids);
  });

  it('refills a half-cleared chunk whole, taking the survivors away', () => {
    const { sim, pid } = room();
    const at = chunkWith(sim, false);
    moveTo(sim, pid, at.x, at.y);
    advance(sim, 5);
    const ids = [...spawnedAt(sim, at).packs];
    kill(sim, ids.slice(0, 1));
    const away = farFrom(sim, at);
    moveTo(sim, pid, away.x, away.y);
    advance(sim, PACK_TICKS + 20);
    sim.world.flushDestroyed();
    const c = spawnedAt(sim, at);
    expect(c.respawns.packs).toBe(1);
    expect(c.packs.length).toBe(ids.length);
    for (const id of ids) expect(sim.world.isAlive(id)).toBe(false);
  });

  it('waits while a survivor is still chasing someone', () => {
    const { sim, pid } = room();
    const at = chunkWith(sim, false);
    moveTo(sim, pid, at.x, at.y);
    advance(sim, 5);
    const ids = spawnedAt(sim, at).packs;
    const survivor = ids[0];
    if (survivor === undefined) throw new Error('empty chunk');
    kill(sim, ids.slice(1));
    const e = sim.world.enemy.get(survivor);
    if (!e) throw new Error('no survivor');
    e.aggro = true;
    const away = farFrom(sim, at);
    moveTo(sim, pid, away.x, away.y);
    advance(sim, PACK_TICKS + 20);
    expect(spawnedAt(sim, at).respawns.packs).toBe(0);
    e.aggro = false;
    advance(sim, STREAMING.respawnRetryTicks + 10);
    expect(spawnedAt(sim, at).respawns.packs).toBe(1);
  });

  it('brings bosses back on their own, longer timer', () => {
    const { sim, pid } = room();
    const at = chunkWith(sim, true);
    moveTo(sim, pid, at.x, at.y);
    advance(sim, 5);
    const c = spawnedAt(sim, at);
    expect(c.bosses.some((id) => sim.world.enemy.get(id)?.boss)).toBe(true);
    kill(sim, [...c.packs, ...c.bosses]);
    const away = farFrom(sim, at);
    moveTo(sim, pid, away.x, away.y);
    advance(sim, PACK_TICKS + 20);
    const mid = spawnedAt(sim, at);
    expect(mid.respawns.bosses).toBe(0);
    expect(mid.bosses.some((id) => sim.world.isAlive(id))).toBe(false);
    if (mid.packs.length > 0 || c.packs.length > 0) expect(mid.respawns.packs).toBe(1);
    advance(sim, BOSS_TICKS - PACK_TICKS);
    const after = spawnedAt(sim, at);
    expect(after.respawns.bosses).toBe(1);
    expect(after.bosses.some((id) => sim.world.isAlive(id) && sim.world.enemy.get(id)?.boss)).toBe(true);
  });

  it('keeps a dead region boss dead in a new room of the same world copy, until the boss timer runs out there', () => {
    const { sim, pid } = room();
    const at = chunkWith(sim, true);
    moveTo(sim, pid, at.x, at.y);
    advance(sim, 5);
    const c = spawnedAt(sim, at);
    // Only the boss pack dies; a living boss elsewhere is not carried.
    kill(sim, c.bosses);
    const memory = rememberWorld(sim);
    const cx = Math.floor(at.x / STREAMING.chunkSize);
    const cy = Math.floor(at.y / STREAMING.chunkSize);
    expect(memory.bosses).toEqual([expect.stringMatching(new RegExp(`^${cx},${cy}:`))]);

    const next = room();
    restoreWorld(next.sim, memory);
    moveTo(next.sim, next.pid, at.x, at.y);
    advance(next.sim, 5);
    const woke = spawnedAt(next.sim, at);
    expect(woke.bosses).toEqual([]);
    expect(woke.packs.length).toBe(c.packs.length);
    expect(woke.packs.every((id) => next.sim.world.isAlive(id))).toBe(true);
    // Still down if this room closes too, before anyone left it for the timer.
    expect(rememberWorld(next.sim).bosses).toEqual(memory.bosses);
    const away = farFrom(next.sim, at);
    moveTo(next.sim, next.pid, away.x, away.y);
    advance(next.sim, BOSS_TICKS - 20);
    expect(spawnedAt(next.sim, at).bosses).toEqual([]);
    advance(next.sim, 40);
    const back = spawnedAt(next.sim, at);
    expect(back.bosses.some((id) => next.sim.world.isAlive(id) && next.sim.world.enemy.get(id)?.boss)).toBe(true);
    expect(rememberWorld(next.sim).bosses).toEqual([]);

    // A key whose chunk now holds other boss packs (a town save changed the world) is dropped.
    const other = room();
    restoreWorld(other.sim, { gates: [], bosses: [`${cx},${cy}:nobody`], chests: [] });
    moveTo(other.sim, other.pid, at.x, at.y);
    advance(other.sim, 5);
    expect(spawnedAt(other.sim, at).bosses.some((id) => other.sim.world.enemy.get(id)?.boss)).toBe(true);
  });

  it('carries opened chests into a new room of the world copy', () => {
    const { sim, pid } = room({ kind: 'world', seed: 3 }, 4);
    const chest = sim.mapDef.chests?.[0];
    if (!chest) throw new Error('no chest');
    moveTo(sim, pid, chest.x + 30, chest.y);
    sim.step();
    const next = room({ kind: 'world', seed: 3 }, 4);
    restoreWorld(next.sim, rememberWorld(sim));
    expect(openedChests(next.sim).has(chestKey(chest))).toBe(true);
  });

  it('refills the same way on every run, from a stream that counts refills', () => {
    const run = (): { first: string[]; refilled: string[]; again: string[] } => {
      const { sim, pid, at } = clearedAndLeft(WILDS_DESC, 21);
      const first = spawnedAt(sim, at).packs.map((id) => describeMonster(sim, id));
      advance(sim, PACK_TICKS + 20);
      const refilled = spawnedAt(sim, at).packs.map((id) => describeMonster(sim, id));
      kill(sim, spawnedAt(sim, at).packs);
      moveTo(sim, pid, at.x, at.y);
      advance(sim, 10);
      const away = farFrom(sim, at);
      moveTo(sim, pid, away.x, away.y);
      advance(sim, PACK_TICKS + 20);
      expect(spawnedAt(sim, at).respawns.packs).toBe(2);
      const again = spawnedAt(sim, at).packs.map((id) => describeMonster(sim, id));
      return { first, refilled, again };
    };
    const a = run();
    const b = run();
    expect(b).toEqual(a);
    // The pack spots stay; the monsters on them roll anew each time.
    expect(a.refilled).not.toEqual(a.first);
    expect(a.again).not.toEqual(a.refilled);
  });

  it('fills an opened chest again on the same rule', () => {
    const { sim, pid } = room({ kind: 'world', seed: 3 }, 4);
    const chest = sim.mapDef.chests?.[0];
    if (!chest) throw new Error('no chest');
    moveTo(sim, pid, chest.x + 30, chest.y);
    sim.step();
    expect(openedChests(sim).has(chestKey(chest))).toBe(true);
    const away = farFrom(sim, chest);
    moveTo(sim, pid, away.x, away.y);
    advance(sim, PACK_TICKS - 20);
    expect(openedChests(sim).has(chestKey(chest))).toBe(true);
    advance(sim, 40);
    expect(openedChests(sim).has(chestKey(chest))).toBe(false);
  });
});

describe('respawn settings', () => {
  it('defaults to 10 minutes, bosses 20', () => {
    expect(DEFAULT_SERVER_SETTINGS.respawnMinutes).toBe(10);
    expect(DEFAULT_SERVER_SETTINGS.bossRespawnMinutes).toBe(20);
  });

  it('accepts minutes in range and refuses the rest', () => {
    expect(parseSettingsPatch({ respawnMinutes: 15, bossRespawnMinutes: 45 })).toEqual({ respawnMinutes: 15, bossRespawnMinutes: 45 });
    expect(parseSettingsPatch({ respawnMinutes: SETTINGS_LIMITS.respawnMinutesMin })).toEqual({ respawnMinutes: 1 });
    for (const bad of [0, SETTINGS_LIMITS.respawnMinutesMax + 1, -5, Number.NaN, '10', null]) {
      expect(typeof parseSettingsPatch({ respawnMinutes: bad }), `respawnMinutes ${String(bad)}`).toBe('string');
      expect(typeof parseSettingsPatch({ bossRespawnMinutes: bad }), `bossRespawnMinutes ${String(bad)}`).toBe('string');
    }
  });

  it('applies a changed time to a running room', () => {
    const { sim, at } = clearedAndLeft();
    setRespawnTimes(sim, { respawnMinutes: 3, bossRespawnMinutes: 3 });
    advance(sim, PACK_TICKS + 20);
    expect(spawnedAt(sim, at).respawns.packs).toBe(0);
    advance(sim, 2 * PACK_TICKS);
    expect(spawnedAt(sim, at).respawns.packs).toBe(1);
  });
});
