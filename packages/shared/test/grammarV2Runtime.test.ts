import { describe, expect, it } from 'vitest';
import { grammarV2, SKILL_BUTTONS, Simulation } from '../src/index.js';

/** `distance` to the dummy: zones are placed on the caster in today's engine. */
function castAtDummy(text: string, distance = 200): number {
  const parsed = grammarV2.parseSpellText(text);
  if (!parsed.ok || !parsed.tree) throw new Error(`${text}: ${JSON.stringify(parsed.errors)}`);
  const rt = grammarV2.toRuntime(parsed.tree);
  if (!rt.ok) throw new Error(`${text}: ${rt.unsupported.join(', ')}`);
  const sim = new Simulation(3);
  sim.waveTimer = Infinity;
  const pid = sim.addPlayer('lab', 'mage');
  const p = sim.world.player.get(pid);
  const pos = sim.world.position.get(pid);
  if (!p || !pos) throw new Error('setup');
  p.sigils = [{ uid: -1, compiled: rt.compiled, misfireMultiplier: 1 }, null, null, null];
  const dummy = sim.spawnEnemy('chaser', pos.x + distance, pos.y);
  const h = sim.world.health.get(dummy);
  const e = sim.world.enemy.get(dummy);
  if (!h || !e) throw new Error('no dummy');
  h.maxLife = 1e9;
  h.life = 1e9;
  e.speedMult = 0;
  let seq = 0;
  for (let t = 0; t < 60; t++) {
    p.heat = 0;
    sim.applyInput(pid, { seq: ++seq, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: SKILL_BUTTONS[0] ?? 0 });
    sim.step();
  }
  return 1e9 - h.life;
}

describe('v2 spells cast in the engine', () => {
  it('castable spells deal damage', () => {
    for (const text of ['orb[every 0.2s] cold split(4) bolt[small]', 'bolt fire onhit nova', 'orb[onexpire] fire split(6) bolt[+30% damage]', 'nova lightning split(3)']) {
      expect(castAtDummy(text), text).toBeGreaterThan(0);
    }
    expect(castAtDummy('zone fire fire', 40)).toBeGreaterThan(0);
  });

  it('names what the engine cannot run yet instead of dropping it', () => {
    const tree = grammarV2.parseSpellText('orb lightning split(3) link').tree;
    if (!tree) throw new Error('no tree');
    const rt = grammarV2.toRuntime(tree);
    expect(rt.ok).toBe(false);
    if (!rt.ok) expect(rt.unsupported).toContain('The link shaper');
    const beam = grammarV2.parseSpellText('beam fire').tree;
    if (!beam) throw new Error('no tree');
    const b = grammarV2.toRuntime(beam);
    expect(!b.ok && b.unsupported.includes('The beam shape')).toBe(true);
  });

  it('doubled infusions hit harder', () => {
    expect(castAtDummy('bolt fire fire')).toBeGreaterThan(castAtDummy('bolt fire'));
  });
});
