import { describe, expect, it } from 'vitest';
import { SKILL_BUTTONS, Simulation, STARTER_SIGILS, type ElementId } from '../src/index.js';
import { serializeEntities } from '../src/sim/snapshot.js';
import { equipStarter } from './harness/parity.js';
import { compileText } from './helpers/spell.js';
import { HEAT } from '../src/index.js';

/**
 * A payload carries its parent's infusions unless it has its own, all the way from the runes to what
 * the client draws: the compiled node, the entity the engine spawns, the element in the snapshot and
 * the element on the damage it deals.
 */
type Seen = Map<string, Set<ElementId | null>>;

function run(setup: (sim: Simulation, pid: number) => void): { entities: Seen; hits: Set<ElementId | null> } {
  const sim = new Simulation(5, { kind: 'flat' });
  sim.waveTimer = Infinity;
  const pid = sim.addPlayer('p', 'mage');
  setup(sim, pid);
  const pos = sim.world.position.get(pid);
  if (!pos) throw new Error('no player');
  const dummy = sim.spawnEnemy('chaser', pos.x + 160, pos.y);
  const entities: Seen = new Map();
  const hits = new Set<ElementId | null>();
  for (let t = 0; t < 120; t++) {
    sim.applyInput(pid, { seq: t + 1, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: t === 0 ? (SKILL_BUTTONS[0] ?? 0) : 0 });
    sim.waveTimer = Infinity;
    sim.step();
    const h = sim.world.health.get(dummy);
    const at = sim.world.position.get(dummy);
    if (h) h.life = h.maxLife;
    if (at) {
      at.x = pos.x + 160;
      at.y = pos.y;
    }
    for (const e of serializeEntities(sim)) {
      if (e.k !== 'projectile' && e.k !== 'nova' && e.k !== 'zone') continue;
      const kind = e.k === 'projectile' ? (e.orb ? 'orb' : 'bolt') : e.k;
      const set = entities.get(kind) ?? new Set<ElementId | null>();
      set.add(e.el);
      entities.set(kind, set);
    }
    for (const { ev } of sim.takeEvents()) if (ev.e === 'dmg' && ev.id === dummy) hits.add(ev.el);
  }
  return { entities, hits };
}

function starter(id: string): (sim: Simulation, pid: number) => void {
  const def = STARTER_SIGILS.find((s) => s.id === id);
  if (!def) throw new Error(id);
  return (sim, pid) => {
    const p = sim.world.player.get(pid);
    if (p) p.sigils = [equipStarter(def)(sim, pid), null, null, null];
  };
}

function text(t: string): (sim: Simulation, pid: number) => void {
  const compiled = compileText(t);
  return (sim, pid) => {
    const p = sim.world.player.get(pid);
    if (p) p.sigils = [{ uid: -1, compiled, misfireMultiplier: 1, castDelay: HEAT.castCooldownSeconds }, null, null, null];
  };
}

describe('payloads inherit their parent infusions', () => {
  it("Frozen Orb's shards are cold", () => {
    const { entities, hits } = run(starter('frozen_orb'));
    expect(entities.get('orb')).toEqual(new Set(['cold']));
    expect(entities.get('bolt')).toEqual(new Set(['cold']));
    expect(hits).toEqual(new Set(['cold']));
  });

  it("Fireball's burst and burning ground are fire, two payload levels down", () => {
    const { entities, hits } = run(starter('fireball'));
    expect(entities.get('orb')).toEqual(new Set(['fire']));
    expect(entities.get('nova')).toEqual(new Set(['fire']));
    expect(entities.get('zone')).toEqual(new Set(['fire']));
    expect(hits).toEqual(new Set(['fire']));
  });

  it('a payload with its own infusion carries that one instead, and passes it on', () => {
    const { entities } = run(text('bolt[onhit] fire nova[after 0.1s] cold zone'));
    expect(entities.get('bolt')).toEqual(new Set(['fire']));
    // Cold attaches to the nova, the nearest shape on its left; the zone inherits it from there.
    expect(entities.get('nova')).toEqual(new Set(['cold']));
    expect(entities.get('zone')).toEqual(new Set(['cold']));
  });

  it('the compiled program carries the inherited element on every level', () => {
    const c = compileText('orb[onhit] lightning nova[after 0.2s] zone[every 0.5s] bolt');
    if (!c.ok) throw new Error('bad spell');
    const levels: string[][] = [];
    let node = c.program.roots[0];
    while (node) {
      levels.push(node.elements);
      node = node.payload[0];
    }
    expect(levels).toEqual([['lightning'], ['lightning'], ['lightning'], ['lightning']]);
  });
});
