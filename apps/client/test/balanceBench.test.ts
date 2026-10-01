import { activeTunables, balanceSpecs, resetTunables, STARTER_SIGILS, TUNABLES, type BenchMeasure, type BenchState } from '@rune/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { bestOf, buildRows, change, filterViews, markOf, ROW_SOURCES, sideOf, sortViews, type BenchRow, type RowView } from '../src/admin/bench/benchRows.js';
import { BenchMeasurer } from '../src/admin/bench/measurer.js';
import { isMeasureJob, isWorkerReply } from '../src/admin/bench/protocol.js';
import { pendingPatch, proposedValues, tuningKey, useTuningDraft } from '../src/admin/tuningDraft.js';

const STATE: BenchState = {
  picks: [{ id: 7, text: 'bolt fire fire', classId: 'ranger', multicast: 1, account: 'boss', token: null, at: 1 }],
  popular: [{ text: 'nova[+50% size] lightning', classId: 'mage', multicast: 1, equipped: 12 }],
  popularAt: 1,
};

const ok = (m: BenchMeasure | undefined) => {
  if (!m?.ok) throw new Error(m ? m.error : 'not measured');
  return m;
};

describe('balance bench preview', () => {
  afterEach(() => resetTunables());

  it('shows a proposed override in the after numbers without saving it or touching the saved set', () => {
    const specs = new Map(TUNABLES.map((s) => [s.path, s]));
    useTuningDraft.setState({ server: { schema: [...TUNABLES], values: {} }, edits: { 'spell.bolt.damage': '40' } });
    const { server, edits } = useTuningDraft.getState();
    const live = server?.values ?? {};
    const pending = pendingPatch(edits, specs, live);
    expect(pending.patch).toEqual({ 'spell.bolt.damage': 40 });
    const proposed = proposedValues(live, pending.patch);
    expect(tuningKey(proposed)).not.toBe(tuningKey(live));
    expect(tuningKey({ b: 1, a: 2 })).toBe(tuningKey({ a: 2, b: 1 }));

    const m = new BenchMeasurer();
    const row = buildRows(STATE).find((r) => r.source === 'pick');
    if (!row) throw new Error('no pick row');
    const before = ok(m.measure(tuningKey(live), live, row.spec));
    const after = ok(m.measure(tuningKey(proposed), proposed, row.spec));
    expect(after.single ?? 0).toBeGreaterThan((before.single ?? 0) * 1.5);
    expect(change(before.single, after.single) ?? 0).toBeGreaterThan(0.5);
    // Back to the saved set: the same numbers as before, measured again rather than only cached.
    expect(ok(new BenchMeasurer().measure(tuningKey(live), live, row.spec)).single).toBe(before.single);
    // Nothing was saved: the draft still holds the edit and no override is stored as live.
    expect(useTuningDraft.getState().server?.values).toEqual({});
    expect(useTuningDraft.getState().edits).toEqual({ 'spell.bolt.damage': '40' });
    // The measurer leaves the last set it measured applied; here that was the saved one.
    expect(activeTunables()).toEqual({});
  });

  it('caches by tuning set and rune text, so the same spell listed twice measures once', () => {
    const m = new BenchMeasurer();
    const rows = buildRows({ ...STATE, popular: [{ text: 'bolt fire fire', classId: 'ranger', multicast: 1, equipped: 3 }] });
    const pick = rows.find((r) => r.source === 'pick');
    const pop = rows.find((r) => r.source === 'popular');
    if (!pick || !pop) throw new Error('rows missing');
    expect(pick.specKey).toBe(pop.specKey);
    expect(pick.id).not.toBe(pop.id);
    const a = m.measure('', {}, pick.spec);
    expect(m.cached('', pop.spec)).toBe(a);
    expect(m.cached('other', pop.spec)).toBeUndefined();
  });

  it('pending edits out of range are counted and left out; a default is sent as null', () => {
    const specs = new Map(TUNABLES.map((s) => [s.path, s]));
    const dmg = specs.get('spell.bolt.damage');
    if (!dmg) throw new Error('no bolt damage');
    const p = pendingPatch({ 'spell.bolt.damage': String(dmg.max + 1), 'spell.bolt.speed': '' }, specs, {});
    expect(p).toEqual({ patch: {}, count: 0, bad: 2 });
    expect(pendingPatch({ 'spell.bolt.damage': String(dmg.default) }, specs, { 'spell.bolt.damage': 30 }).patch).toEqual({ 'spell.bolt.damage': null });
    expect(proposedValues({ 'spell.bolt.damage': 30, x: 1 }, { 'spell.bolt.damage': null, y: 2 })).toEqual({ x: 1, y: 2 });
  });
});

describe('balance bench rows', () => {
  const rows = buildRows(STATE);

  it('lists every kit, every balance spell, the most equipped and the picks', () => {
    expect(rows.filter((r) => r.source === 'kit')).toHaveLength(STARTER_SIGILS.length);
    expect(rows.filter((r) => r.source === 'balance')).toHaveLength(balanceSpecs().length);
    expect(rows.find((r) => r.source === 'popular')?.equipped).toBe(12);
    expect(rows.find((r) => r.source === 'pick')?.pick?.account).toBe('boss');
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(buildRows(null).length).toBe(STARTER_SIGILS.length + balanceSpecs().length);
  });

  const fake = (single: number, pack: number, kind: 'damage' | 'movement' = 'damage'): BenchMeasure => ({ ok: true, kind, force: 10, spirit: null, casts: 29, single, pack });

  it('divides by the best damage kit under the same set and marks above 2x and 5x', () => {
    const kits = rows.filter((r) => r.source === 'kit');
    expect(bestOf(rows, () => undefined)).toBeNull();
    const best = bestOf(rows, (r) => (r === kits[0] ? fake(2, 8) : r === kits[1] ? fake(9, 99, 'movement') : fake(1, 4)));
    expect(best).toEqual({ single: 2, pack: 8 });
    const side = sideOf(fake(5, 8), best);
    expect(side.xSingle).toBe(2.5);
    expect(side.xPack).toBe(1);
    expect(markOf(side)).toBe('soft');
    expect(markOf(sideOf(fake(11, 8), best))).toBe('hard');
    expect(markOf(sideOf(fake(4, 16), best))).toBeNull();
    expect(sideOf({ ok: false, error: 'x' }, best).xSingle).toBeNull();
  });

  const view = (row: BenchRow, before: number | null, after: number | null): RowView => {
    const best = { single: 1, pack: 1 };
    return { row, before: sideOf(before === null ? undefined : fake(before, before), best), after: sideOf(after === null ? undefined : fake(after, after), best) };
  };

  it('sorts either way with unmeasured rows last, and filters by source, class, text, outliers and change', () => {
    const [a, b, c, d] = rows;
    if (!a || !b || !c || !d) throw new Error('rows missing');
    const views = [view(a, 1, 1), view(b, 3, 3), view(c, null, null), view(d, 1, 1.2)];
    expect(sortViews(views, { key: 'x', desc: true }).map((v) => v.row)).toEqual([b, d, a, c]);
    expect(sortViews(views, { key: 'x', desc: false }).map((v) => v.row)).toEqual([a, d, b, c]);
    expect(sortViews(views, { key: 'change', desc: true })[0]?.row).toBe(d);
    const all = { sources: new Set(ROW_SOURCES), classId: 'all' as const, query: '', outliers: false, changed: false };
    expect(filterViews(views, all)).toHaveLength(4);
    expect(filterViews(views, { ...all, outliers: true }).map((v) => v.row)).toEqual([b]);
    expect(filterViews(views, { ...all, changed: true }).map((v) => v.row)).toEqual([d]);
    expect(filterViews(views, { ...all, sources: new Set(['pick'] as const) })).toHaveLength(0);
    expect(filterViews(views, { ...all, classId: a.classId }).every((v) => v.row.classId === a.classId)).toBe(true);
    expect(filterViews(views, { ...all, query: a.text.toUpperCase() }).map((v) => v.row)).toContain(a);
  });
});

describe('bench worker messages', () => {
  it('checks jobs and replies on both sides', () => {
    expect(isMeasureJob({ t: 'job', sets: { '': {} }, tasks: [{ setKey: '', spec: { kind: 'kit', kitId: 'fireball' } }] })).toBe(true);
    expect(isMeasureJob({ t: 'job', sets: { '': { a: 'x' } }, tasks: [] })).toBe(false);
    expect(isMeasureJob({ t: 'job', sets: {}, tasks: [{ setKey: '', spec: { kind: 'spell', text: 'bolt', classId: 'pirate', multicast: 1 } }] })).toBe(false);
    expect(isWorkerReply({ t: 'idle' })).toBe(true);
    expect(isWorkerReply({ t: 'result', setKey: '', rowKey: 'kit:x', ms: 1, measure: { ok: false, error: 'no' } })).toBe(true);
    expect(isWorkerReply({ t: 'result', setKey: '', rowKey: 'kit:x', ms: 1, measure: { ok: true, kind: 'damage', force: 1, spirit: null, casts: 2, single: NaN, pack: 1 } })).toBe(false);
  });
});

describe('bench speed', () => {
  it('measures every row of a full bench in a few ms each', () => {
    const popular = Array.from({ length: 20 }, (_, i) => ({ text: `bolt[+${10 + i}% damage] fire`, classId: 'ranger' as const, multicast: 1, equipped: 20 - i }));
    const rows = buildRows({ ...STATE, popular });
    const m = new BenchMeasurer();
    const t0 = performance.now();
    for (const r of rows) m.measure('', {}, r.spec);
    const each = (performance.now() - t0) / rows.length;
    console.log(`\nbench rows: ${rows.length}, ${each.toFixed(1)} ms each\n`);
    expect(each).toBeLessThan(20);
  });
});
