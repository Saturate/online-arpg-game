import { describe, expect, it } from 'vitest';
import {
  bracketTree,
  describeTree,
  EXAMPLE_SPELLS,
  parseSpell,
  parseSpellText,
  tokenizeSpell,
  type GrammarContext,
  type RuleId,
  type SpellNode,
  type TextParseResult,
} from '../src/runes/v2/index.js';

function p(text: string, ctx: Partial<GrammarContext> = {}): TextParseResult {
  return parseSpellText(text, ctx);
}

function ok(text: string, ctx: Partial<GrammarContext> = {}) {
  const r = p(text, ctx);
  if (!r.ok || !r.tree) throw new Error(`${text} failed: ${r.errors.map((e) => `${e.rule}: ${e.message}`).join('; ')}`);
  return { ...r, tree: r.tree, sentence: describeTree(r.tree), bracket: bracketTree(r.tree) };
}

function rules(text: string, ctx: Partial<GrammarContext> = {}): RuleId[] {
  return p(text, ctx).errors.map((e) => e.rule);
}

function errorAt(text: string, rule: RuleId, runeIndex: number, ctx: Partial<GrammarContext> = {}): string {
  const r = p(text, ctx);
  const e = r.errors.find((x) => x.rule === rule);
  if (!e) throw new Error(`${text}: expected ${rule}, got ${JSON.stringify(r.errors)}`);
  expect(e.runeIndex).toBe(runeIndex);
  return e.message;
}

function root(text: string, ctx: Partial<GrammarContext> = {}): SpellNode {
  const r = ok(text, ctx);
  const n = r.tree.roots[0];
  if (!n) throw new Error('no root');
  return n;
}

function first(nodes: readonly SpellNode[]): SpellNode {
  const n = nodes[0];
  if (!n) throw new Error('no node');
  return n;
}

function child(node: SpellNode, i = 0): SpellNode {
  const c = node.payload[i];
  if (!c) throw new Error(`no payload ${i}`);
  return c;
}

describe('plan examples', () => {
  it('winter orb: slow cold orb pulsing four small bolts', () => {
    const r = ok('Orb[slow, every 0.2s] Cold Split(4) Bolt[small]');
    expect(r.sentence).toBe('Fires a slow cold orb. Every 0.2 s it releases 4 small bolts.');
    expect(r.bracket).toBe('Orb[slow, cold] { every 0.2s: Split4 Bolt[small] }');
    const orb = r.tree.roots[0];
    expect(orb?.copies).toBe(1);
    expect(orb?.infusions).toEqual(['cold']);
    expect(orb && child(orb).effectiveInfusions).toEqual(['cold']);
  });

  it('winter orb without slow matches the requested bracket view', () => {
    expect(ok('Orb[every 0.2s] Cold Split(4) Bolt').bracket).toBe('Orb[cold] { every 0.2s: Split4 Bolt }');
  });

  it('entity budget counts the peak alive, not the lifetime total', () => {
    const r = ok('Orb[every 0.2s] Cold Split(4) Bolt[small]');
    // Orb lives 2 s, pulses 10 times; bolts live 1 s so 5 volleys overlap: 1 + 5 * 4.
    expect(r.stats.peakEntities).toBe(21);
    expect(r.stats.lifetimeEntities).toBe(41);
    expect(r.stats.lifetimeEntities).toBeGreaterThan(40);
  });

  it('linked balls: split and link stay on the orb', () => {
    const r = ok('Orb Lightning Split(3) Link');
    expect(r.bracket).toBe('Split3 Orb[lightning, link]');
    expect(r.sentence).toBe('Fires 3 lightning orbs, linked by beams.');
    expect(r.tree.roots[0]?.linked).toBe(true);
    expect(r.stats.peakEntities).toBe(5);
  });

  it('endgame embers need multicast 2 for Nova + Zone in the payload', () => {
    const text = 'Orb[onexpire] Fire Split(6) Orb[onhit, homing] Nova Zone[long]';
    const r = ok(text, { multicast: 2 });
    expect(r.bracket).toBe('Orb[fire] { on expire: Split6 Orb[homing] { on hit: Nova + Zone[long] } }');
    expect(r.sentence).toBe(
      'Fires a fire orb. When it expires it releases 6 homing orbs. On hit each releases a nova and a long-lasting zone at once.',
    );
    expect(r.stats.depth).toBe(2);
    const zone = child(child(first(r.tree.roots)), 1);
    expect(zone.effectiveInfusions).toEqual(['fire']);
    expect(zone.castTogether).toBe(true);
    const msg = errorAt(text, 'multicast', 5);
    expect(msg).toContain('multicast is 1');
  });

  it('fireball from the plan', () => {
    const r = ok('Orb[onhit, -15% speed, +30% damage] Fire Nova[after 0.5s] Zone[long]');
    expect(r.bracket).toBe('Orb[slow, fire, +30% damage] { on hit: Nova { after 0.5s: Zone[long] } }');
    expect(r.sentence).toBe(
      'Fires a slow fire orb, with +30% damage. On hit it releases a nova. After 0.5 s it releases a long-lasting zone.',
    );
  });

  it('multishot', () => {
    const r = ok('Arrow Split(5)');
    expect(r.sentence).toBe('Shoots 5 arrows.');
    expect(r.bracket).toBe('Split5 Arrow');
  });

  it('rain of arrows', () => {
    const r = ok('Arrow[onexpire] Split(6) Arrow[small]');
    expect(r.bracket).toBe('Arrow { on expire: Split6 Arrow[small] }');
    expect(r.sentence).toBe('Shoots an arrow. When it expires it releases 6 small arrows.');
  });

  it('frost trap: the nova inherits cold', () => {
    const r = ok('Trap[onhit] Cold Nova[large]');
    expect(r.sentence).toBe('Sets a cold trap. When triggered it releases a large nova.');
    const nova = child(first(r.tree.roots));
    expect(nova.infusions).toEqual([]);
    expect(nova.effectiveInfusions).toEqual(['cold']);
  });

  it('beam + charge: charge stays on the beam, split goes to the bolts', () => {
    const r = ok('Beam[onrelease] Charge(3) Split(3) Bolt');
    expect(r.bracket).toBe('Beam[charge3] { on release: Split3 Bolt }');
    expect(r.sentence).toBe('Hold to charge (3 stages), then release: channels a charged beam. When you let go it releases 3 bolts.');
  });

  it('every example spell parses as its note says', () => {
    for (const e of EXAMPLE_SPELLS) {
      const r = p(e.text, e.context);
      expect(r.ok, `${e.name}: ${JSON.stringify(r.errors)}`).toBe(!e.name.startsWith('Bad:'));
    }
  });
});

describe('open question 1: Swift and Large as plain runes', () => {
  it('are allowed by default (owner decision), and can be switched off', () => {
    expect(root('Bolt Swift').stats.speed).toBe(30);
    expect(errorAt('Bolt Swift', 'plain-modifier-off', 1, { plainModifierRunes: false })).toContain('[fast]');
  });

  it('work like the affix when turned on', () => {
    const bolt = root('Bolt Swift Large', { plainModifierRunes: true });
    expect(bolt.stats.speed).toBe(30);
    expect(bolt.stats.size).toBe(50);
  });
});

describe('ambiguous cases', () => {
  it('Link without a Split is an error on the Link', () => {
    expect(errorAt('Orb Link', 'link-needs-split', 1)).toContain('no Split');
  });

  it('Link before its Split is an error even when a Split follows', () => {
    errorAt('Orb Link Split(3)', 'link-needs-split', 1);
  });

  it('an infusion after a trigger goes to the parent; the payload inherits it', () => {
    const bolt = root('Bolt OnHit Fire Nova');
    expect(bolt.infusions).toEqual(['fire']);
    expect(child(bolt).infusions).toEqual([]);
    expect(child(bolt).effectiveInfusions).toEqual(['fire']);
  });

  it('a payload with its own infusion does not inherit', () => {
    const orb = root('Orb[onexpire] Fire Bolt Cold');
    expect(child(orb).effectiveInfusions).toEqual(['cold']);
  });

  it('a Split before a trigger rune splits the parent; after it, the payload', () => {
    const a = root('Orb Split(3) OnExpire Bolt');
    expect(a.copies).toBe(3);
    expect(child(a).copies).toBe(1);
    const b = root('Orb OnExpire Split(3) Bolt');
    expect(b.copies).toBe(1);
    expect(child(b).copies).toBe(3);
  });

  it('a Link right after a payload Split goes with it', () => {
    const orb = root('Orb[onexpire] Split(3) Link Bolt');
    expect(child(orb).linked).toBe(true);
    expect(orb.linked).toBe(false);
  });

  it('two release shapes in a row nest', () => {
    const r = ok('Orb[onexpire] Bolt[onhit] Nova');
    expect(r.bracket).toBe('Orb { on expire: Bolt { on hit: Nova } }');
    expect(r.stats.depth).toBe(2);
  });

  it('multicast applies inside payloads too', () => {
    errorAt('Orb[onhit] Nova Zone', 'multicast', 2);
    const r = ok('Orb[onhit] Nova Zone', { multicast: 2 });
    expect(r.bracket).toBe('Orb { on hit: Nova + Zone }');
  });

  it('multicast error names the first extra shape', () => {
    expect(errorAt('Bolt Nova Orb', 'multicast', 2, { multicast: 2 })).toContain('Orb (rune 3)');
  });

  it('Dash mid-list: cast together counts against multicast, and never as a payload', () => {
    errorAt('Bolt Dash', 'multicast', 1);
    expect(ok('Bolt Dash', { multicast: 2 }).sentence).toBe('Fires a bolt and performs a dash at once.');
    errorAt('Orb[onhit] Dash', 'dash-root-only', 1);
  });

  it('persistent shapes must stand alone', () => {
    errorAt('Aura Fire Bolt', 'persistent-alone', 2);
    errorAt('Bolt Aura', 'persistent-alone', 1, { multicast: 2 });
    errorAt('Aura[onhit] Nova', 'persistent-no-release', 0);
    errorAt('Aura Split(3)', 'persistent-no-split', 1);
    errorAt('Bond Charge', 'persistent-no-charge', 1);
  });

  it('a trailing trigger or release affix with no payload is an error', () => {
    errorAt('Bolt Fire OnHit', 'trailing-release', 2);
    errorAt('Orb[every 0.2s] Cold', 'trailing-release', 0);
    errorAt('Orb[onexpire] Split(3)', 'trailing-release', 0);
  });

  it('charge works on a nova', () => {
    const r = ok('Nova Charge');
    expect(r.sentence).toBe('Hold to charge (3 stages), then release: casts a charged nova.');
  });

  it('chain does not work on a zone', () => {
    expect(errorAt('Zone Chain', 'shaper-not-for-shape', 1)).toContain('Chain does not work on Zone');
  });

  it('link after multicast is an error: Link joins copies of one shape', () => {
    errorAt('Orb Split(3) Bolt Link', 'link-needs-split', 3, { multicast: 2 });
  });
});

describe('rules', () => {
  it('the first rune must be a shape', () => {
    expect(errorAt('Fire Orb', 'first-rune-shape', 0)).toContain('is an infusion');
    expect(errorAt('Split Orb', 'first-rune-shape', 0)).toContain('is a shaper');
  });

  it('empty spells are errors', () => {
    expect(parseSpell([]).errors[0]?.rule).toBe('empty');
  });

  it('a shape releases one way', () => {
    errorAt('Orb[onhit] OnExpire Bolt', 'one-release', 1);
  });

  it('release kinds follow TRIGGERS_FOR_SHAPE', () => {
    errorAt('Nova[every 0.2s] Bolt', 'release-not-for-shape', 0);
    errorAt('Bolt[onland] Nova', 'release-not-for-shape', 0);
    errorAt('Arrow Pulse Bolt', 'release-not-for-shape', 1);
    expect(ok('Dash[onland] Nova').bracket).toBe('Dash { on land: Nova }');
  });

  it('on release needs Charge or a Beam', () => {
    errorAt('Orb[onrelease] Nova', 'onrelease-needs-hold', 0);
    ok('Orb[onrelease] Charge Nova');
    ok('Beam[onrelease] Nova');
  });

  it('release intervals have a floor', () => {
    errorAt('Orb[every 0.05s] Bolt', 'release-interval', 0);
  });

  it('doubled runes stack for now: splits multiply up to 12, shapers add up, Link and Orbit stay once', () => {
    expect(root('Orb Split(3) Split(2)').copies).toBe(6);
    errorAt('Orb Split(4) Split(4)', 'split-once', 2);
    errorAt('Orb Split(7)', 'split-count', 1);
    expect(root('Orb Homing Homing').shapers.filter((s) => s.id === 'homing')).toHaveLength(2);
    errorAt('Orb Split(3) Link Link', 'duplicate-shaper', 3);
    expect(root('Orb Fire Fire').infusions).toEqual(['fire', 'fire']);
    expect(root('Nova Split(3)').copies).toBe(3);
  });

  it('shaper and affix compatibility', () => {
    errorAt('Nova Orbit', 'shaper-not-for-shape', 1);
    errorAt('Zone Homing', 'shaper-not-for-shape', 1);
    errorAt('Nova[homing]', 'affix-not-allowed', 0);
    errorAt('Zone[pierce 2]', 'affix-not-allowed', 0);
    errorAt('Orb Fire[onhit]', 'affix-not-allowed', 1);
  });

  it('charge only on the cast itself', () => {
    errorAt('Orb[onhit] Bolt Charge', 'charge-root-only', 2);
  });

  it('depth limit', () => {
    const text = 'Bolt[onexpire] Bolt[onexpire] Bolt[onexpire] Bolt[onexpire] Bolt';
    expect(errorAt(text, 'max-depth', 4)).toContain('limit is 3');
    expect(p(text, { maxDepth: 4 }).errors.map((e) => e.rule)).not.toContain('max-depth');
  });

  it('entity cap names the peak', () => {
    expect(errorAt('Orb[every 0.2s] Split(4) Orb[every 0.2s] Bolt', 'entity-cap', -1)).toContain('241');
    expect(rules('Arrow Split(5)', { liveCap: 4 })).toEqual(['entity-cap']);
  });

  it('every error carries a rule, a rune index in range and a message', () => {
    const texts = ['Fire', 'Orb Link', 'Aura Split(3) Bolt', 'Bolt Nova Zone OnHit', 'Zone Chain Homing', 'Orb[onrelease] Nova'];
    for (const t of texts) {
      const r = p(t);
      expect(r.errors.length, t).toBeGreaterThan(0);
      for (const e of r.errors) {
        expect(e.message.length).toBeGreaterThan(10);
        expect(e.runeIndex).toBeLessThan(r.tokens.length);
        expect(e.runeIndex).toBeGreaterThanOrEqual(-1);
      }
    }
  });
});

describe('tokenizer', () => {
  it('is case-insensitive and reads counts three ways', () => {
    for (const t of ['ORB split(4)', 'orb split4', 'orb split 4', 'orb, split[count 4]']) {
      const r = tokenizeSpell(t);
      expect(r.errors, t).toEqual([]);
      expect(r.runes[1]).toEqual({ id: 'split', affixes: { count: 4 } });
    }
  });

  it('reads "on hit" as one rune and affixes in brackets', () => {
    const r = tokenizeSpell('bolt on hit nova[after 0.3s, +20% damage, pierce 2]');
    expect(r.errors).toEqual([]);
    expect(r.runes.map((x) => x.id)).toEqual(['bolt', 'onhit', 'nova']);
    expect(r.runes[2]?.affixes).toEqual({ release: { kind: 'after', seconds: 0.3 }, damage: 20, pierce: 2 });
    expect(r.tokens[1]?.text).toBe('on hit');
  });

  it('reports unknown runes, affixes and counts by word', () => {
    expect(tokenizeSpell('orb fireball').errors[0]).toMatchObject({ rule: 'unknown-rune', runeIndex: 1 });
    expect(tokenizeSpell('orb[wobbly]').errors[0]).toMatchObject({ rule: 'unknown-affix', runeIndex: 0 });
    expect(tokenizeSpell('orb fire(3)').errors[0]).toMatchObject({ rule: 'bad-count', runeIndex: 1 });
  });

  it('timer and pulse runes take seconds', () => {
    const orb = root('orb timer(0.8) bolt');
    expect(orb.release).toMatchObject({ kind: 'after', seconds: 0.8, source: 'rune' });
    expect(root('orb pulse bolt').release).toMatchObject({ kind: 'every', seconds: 0.25 });
  });
});
