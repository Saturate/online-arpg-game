import { describe, expect, it } from 'vitest';
import {
  compileRunes,
  DEFAULT_SIGIL_CONTEXT,
  DEFAULT_SERVER_SETTINGS,
  HEAT,
  SIM,
  SKILL_BUTTONS,
  SPELL,
  Simulation,
  tokenizeSpell,
  type EntityId,
  type SigilCompile,
} from '../src/index.js';

function compile(text: string, multicast = 1): SigilCompile {
  const t = tokenizeSpell(text);
  if (t.errors.length > 0) throw new Error(t.errors.map((e) => e.message).join('; '));
  const c = compileRunes(t.runes, { ...DEFAULT_SIGIL_CONTEXT, classId: 'mage', multicast });
  if (!c.ok) throw new Error(`${text}: ${c.errors.map((e) => e.message).join('; ')}`);
  return c;
}

interface Bench {
  sim: Simulation;
  pid: EntityId;
  /** One tick; `hold` keeps the skill button down, and Force is refilled so it never runs out. */
  tick(hold?: boolean): { casts: number };
  dummies: EntityId[];
  damageOf(id: EntityId): number;
}

/** A mage with only `text` in slot 0 and pinned, unkillable dummies at `spots` (relative to the mage). */
function bench(text: string, opts: { multicast?: number; castDelayShare?: number; spots?: { x: number; y: number }[] } = {}): Bench {
  const sim = new Simulation(5, { kind: 'flat' });
  sim.waveTimer = Infinity;
  const pid = sim.addPlayer('engine', 'mage');
  const p = sim.world.player.get(pid);
  const pos = sim.world.position.get(pid);
  if (!p || !pos) throw new Error('setup');
  p.god = true;
  p.warband = p.warband.map(() => null);
  p.sigils = [{ uid: -1, compiled: compile(text, opts.multicast), misfireMultiplier: 1, castDelayShare: opts.castDelayShare ?? 1 }, null, null, null];
  const home = { x: pos.x, y: pos.y };
  const dummies = (opts.spots ?? []).map((s) => {
    const id = sim.spawnEnemy('chaser', home.x + s.x, home.y + s.y);
    const h = sim.world.health.get(id);
    if (h) {
      h.maxLife = 1e9;
      h.life = 1e9;
    }
    return id;
  });
  const at = new Map(dummies.map((id) => [id, { ...(sim.world.position.get(id) ?? home) }]));
  let seq = 0;
  return {
    sim,
    pid,
    dummies,
    damageOf: (id) => 1e9 - (sim.world.health.get(id)?.life ?? 1e9),
    tick(hold = false) {
      p.heat = 0;
      sim.applyInput(pid, { seq: ++seq, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: hold ? (SKILL_BUTTONS[0] ?? 0) : 0 });
      sim.waveTimer = Infinity;
      sim.step();
      for (const [id, spot] of at) {
        const dp = sim.world.position.get(id);
        const e = sim.world.enemy.get(id);
        if (dp) Object.assign(dp, spot);
        if (e) {
          e.knockX = 0;
          e.knockY = 0;
          e.speedMult = 0;
        }
      }
      const self = sim.world.position.get(pid);
      if (self) Object.assign(self, home);
      let casts = 0;
      for (const { ev } of sim.takeEvents()) if (ev.e === 'cast' && ev.id === pid) casts++;
      return { casts };
    },
  };
}

/** Ticks until `done` holds, returning how many it took, or -1 after `limit`. */
function ticksUntil(b: Bench, done: () => boolean, limit = 200): number {
  for (let t = 1; t <= limit; t++) {
    b.tick();
    if (done()) return t;
  }
  return -1;
}

/** Ticks between the casts of a held key over `ticks` ticks. */
function castGaps(b: Bench, ticks: number): number[] {
  const castTicks: number[] = [];
  for (let t = 0; t < ticks; t++) if (b.tick(true).casts > 0) castTicks.push(t);
  return castTicks.slice(1).map((t, i) => t - (castTicks[i] ?? 0));
}

describe('cast cooldown', () => {
  it('waits exactly its seconds, not a tick more for a float remainder', () => {
    for (const [seconds, every] of [
      [0.3, 6],
      [0.35, 7],
      [HEAT.castCooldownSeconds, HEAT.castCooldownSeconds / SIM.dt],
    ] as const) {
      const b = bench('bolt');
      b.sim.setRates({ ...b.sim.rates, castCooldown: seconds });
      expect(new Set(castGaps(b, 61)), `cooldown ${seconds}`).toEqual(new Set([Math.round(every)]));
    }
  });

  it('defaults to the admin default and is shortened by the cast delay share and cast speed', () => {
    const b = bench('bolt', { castDelayShare: 0.8 });
    expect(b.sim.rates.castCooldown).toBe(DEFAULT_SERVER_SETTINGS.castCooldownSeconds);
    const p = b.sim.world.player.get(b.pid);
    if (!p) throw new Error('setup');
    p.stats = { ...p.stats, castSpeedMult: 2 };
    // 0.5 x 0.8 / 2 = 0.2 s, four ticks.
    expect(new Set(castGaps(b, 41))).toEqual(new Set([Math.round((HEAT.castCooldownSeconds * 0.8) / 2 / SIM.dt)]));
  });

  it('follows a changed setting on the next cast, without touching the running cooldown', () => {
    const b = bench('bolt');
    expect(b.tick(true).casts).toBe(1);
    const p = b.sim.world.player.get(b.pid);
    if (!p) throw new Error('setup');
    const running = p.castCooldown;
    b.sim.setRates({ ...b.sim.rates, castCooldown: 1 });
    expect(p.castCooldown).toBe(running);
    castGaps(b, 20);
    expect(new Set(castGaps(b, 81))).toEqual(new Set([20]));
  });
});

describe('the engine runs v2 programs', () => {
  it('casts shapes together (multicast)', () => {
    const b = bench('bolt nova', { multicast: 2 });
    b.tick(true);
    expect(b.sim.world.projectile.size).toBe(1);
    expect(b.sim.world.nova.size).toBe(1);
  });

  it('releases a payload of several shapes at once', () => {
    const b = bench('bolt[onhit] fire nova zone', { multicast: 2, spots: [{ x: 150, y: 0 }] });
    b.tick(true);
    const t = ticksUntil(b, () => b.sim.world.nova.size > 0);
    expect(t).toBeGreaterThan(0);
    expect(b.sim.world.zone.size).toBe(1);
  });

  it('releases "after X s" at each node\'s own X', () => {
    for (const [seconds, ticks] of [
      [0.2, 4],
      [0.8, 16],
    ] as const) {
      const b = bench(`bolt[after ${seconds}s, -80% speed] nova`);
      b.tick(true);
      // The cast tick already aged the bolt one tick.
      expect(ticksUntil(b, () => b.sim.world.nova.size > 0) + 1, `after ${seconds}`).toBe(ticks);
    }
  });

  it('still releases "after X s" when the shape ended first, where it ended', () => {
    // A nova lives 0.3 s; its zone must come 0.5 s after the nova appeared, not when it ends.
    const b = bench('nova[after 0.5s] zone');
    b.tick(true);
    expect(b.sim.world.nova.size).toBe(1);
    const t = ticksUntil(b, () => b.sim.world.zone.size > 0);
    expect(b.sim.world.nova.size).toBe(0);
    expect(t + 1).toBe(10);
  });

  it('releases "every X s" on each node\'s own interval', () => {
    const count = (every: number): number => {
      const b = bench(`orb[every ${every}s] split(2) bolt`);
      b.tick(true);
      let shards = 0;
      const seen = new Set<EntityId>();
      for (let t = 0; t < 30; t++) {
        b.tick();
        for (const [id, proj] of b.sim.world.projectile) {
          if (proj.spell?.node.form !== 'bolt' || seen.has(id)) continue;
          seen.add(id);
          shards++;
        }
      }
      return shards;
    };
    // 1.5 s of flight: every 0.5 s is 3 releases of 2, every 0.25 s is 6.
    expect(count(0.5)).toBe(6);
    expect(count(0.25)).toBe(12);
  });

  it('flies each node at its own speed and size', () => {
    const b = bench('orb[-20% speed, +50% size]');
    b.tick(true);
    const [id] = [...b.sim.world.projectile.keys()];
    if (id === undefined) throw new Error('no orb');
    const v = b.sim.world.velocity.get(id);
    expect(Math.hypot(v?.x ?? 0, v?.y ?? 0)).toBeCloseTo(SPELL.orb.speed * 0.8);
    expect(b.sim.world.radius.get(id)).toBeCloseTo(SPELL.orb.radius * 1.5);
  });

  it('rolls an orb through every enemy, while a bolt stops at the first', () => {
    const line = [120, 170, 220, 270].map((x) => ({ x, y: 0 }));
    const hit = (text: string): number => {
      const b = bench(text, { spots: line });
      b.tick(true);
      for (let t = 0; t < 60; t++) b.tick();
      return b.dummies.filter((d) => b.damageOf(d) > 0).length;
    };
    expect(hit('orb')).toBe(4);
    expect(hit('bolt')).toBe(1);
    expect(hit('bolt[pierce 2]')).toBe(3);
    // Bursting on hit ends the roll.
    expect(hit('orb[onhit] zone[-90% size]')).toBe(1);
  });
});
