import type { InjectedSpell } from './SpellStudioTab.js';
import { grammarV2 } from '@rune/shared';
import { useMemo, useState } from 'react';

type GrammarContext = grammarV2.GrammarContext;
type SpellNode = grammarV2.SpellNode;
type RuneId = grammarV2.RuneId;

const { EXAMPLE_SPELLS, RULES, DEFAULT_CONTEXT, parseSpellText, describeTree, bracketTree, runeName, SHAPES } = grammarV2;

const PALETTE: readonly { label: string; runes: readonly RuneId[] }[] = [
  { label: 'Shapes', runes: grammarV2.SHAPE_IDS },
  { label: 'Infusions', runes: grammarV2.INFUSION_IDS },
  { label: 'Shapers', runes: grammarV2.SHAPER_IDS },
  { label: 'Effects', runes: grammarV2.EFFECT_IDS },
  { label: 'Triggers', runes: grammarV2.TRIGGER_IDS },
  { label: 'Plain modifiers', runes: grammarV2.PLAIN_MODIFIER_IDS },
];

const AFFIX_SNIPPETS: readonly string[] = ['[onhit]', '[onexpire]', '[every 0.2s]', '[after 0.5s]', '[onrelease]', '[onland]', '[slow]', '[small]', '[large]', '[long]', '[homing]', '[pierce 2]', '[+30% damage]', '(4)'];

const CONTEXT_FIELDS: readonly { key: 'multicast' | 'maxDepth' | 'liveCap'; label: string; min: number; max: number }[] = [
  { key: 'multicast', label: 'Multicast', min: 1, max: 6 },
  { key: 'maxDepth', label: 'Max depth', min: 0, max: 8 },
  { key: 'liveCap', label: 'Live cap', min: 1, max: 500 },
];

function NodeRow({ node }: { node: SpellNode }) {
  const inherited = node.infusions.length === 0 && node.effectiveInfusions.length > 0;
  return (
    <li>
      <div className="lab-node">
        <strong>
          {node.copies > 1 ? `${node.copies} x ` : ''}
          {SHAPES[node.shape].name}
        </strong>
        <small>rune {node.runeIndex + 1}</small>
        <small>depth {node.depth}</small>
        {node.castTogether && <small>cast together</small>}
        {node.effectiveInfusions.length > 0 && (
          <small>
            {node.effectiveInfusions.join(', ')}
            {inherited ? ' (inherited)' : ''}
          </small>
        )}
        {node.shapers.length > 0 && <small>{node.shapers.map((s) => `${runeName(s.id)} ${s.value}`).join(', ')}</small>}
        {node.release && (
          <small>
            releases {node.release.kind}
            {node.release.seconds ? ` ${node.release.seconds}s` : ''} via {node.release.source}
          </small>
        )}
      </div>
      {node.payload.length > 0 && (
        <ul className="lab-tree">
          {node.payload.map((c) => (
            <NodeRow key={c.runeIndex} node={c} />
          ))}
        </ul>
      )}
    </li>
  );
}

function clampInt(v: string, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function SpellLabTab({ onCast }: { onCast?: (spell: InjectedSpell) => void }) {
  const first = EXAMPLE_SPELLS[0];
  const [text, setText] = useState(first?.text ?? 'orb');
  const [ctx, setCtx] = useState<GrammarContext>({ ...DEFAULT_CONTEXT, ...first?.context });
  const [exampleId, setExampleId] = useState(first?.id ?? '');
  const [showRules, setShowRules] = useState(false);

  const result = useMemo(() => parseSpellText(text, ctx), [text, ctx]);
  const badIndices = useMemo(() => new Set(result.errors.map((e) => e.runeIndex)), [result.errors]);
  const example = EXAMPLE_SPELLS.find((e) => e.id === exampleId);
  const runtime = useMemo(() => (result.ok && result.tree ? grammarV2.toRuntime(result.tree) : null), [result]);

  const append = (snippet: string, glue: boolean): void => {
    setText((t) => (glue || t.trim() === '' ? `${t.trimEnd()}${snippet}` : `${t.trimEnd()} ${snippet}`));
  };

  const pickExample = (id: string): void => {
    const e = EXAMPLE_SPELLS.find((x) => x.id === id);
    setExampleId(id);
    if (!e) return;
    setText(e.text);
    setCtx({ ...DEFAULT_CONTEXT, ...e.context });
  };

  return (
    <div className="lab">
      <aside className="dev-side lab-side">
        <h3>Example</h3>
        <select value={exampleId} onChange={(e) => pickExample(e.target.value)}>
          <option value="">(custom)</option>
          {EXAMPLE_SPELLS.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        {example && <p className="lab-note">{example.note}</p>}

        <h3>Runes</h3>
        {PALETTE.map((group) => (
          <div key={group.label} className="lab-palette">
            <small>{group.label}</small>
            <div className="chip-row">
              {group.runes.map((id) => (
                <button key={id} type="button" onClick={() => append(id, false)}>
                  {runeName(id)}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="lab-palette">
          <small>Affixes (append to the last rune)</small>
          <div className="chip-row">
            {AFFIX_SNIPPETS.map((s) => (
              <button key={s} type="button" onClick={() => append(s, true)}>
                {s}
              </button>
            ))}
          </div>
        </div>

        <h3>Context</h3>
        <div className="studio-fields">
          {CONTEXT_FIELDS.map((f) => (
            <label key={f.key}>
              {f.label}
              <input
                type="number"
                min={f.min}
                max={f.max}
                value={ctx[f.key]}
                onChange={(e) => {
                  const value = clampInt(e.target.value, f.min, f.max, ctx[f.key]);
                  setCtx((c) => ({ ...c, [f.key]: value }));
                }}
              />
            </label>
          ))}
          <label className="check span">
            <input
              type="checkbox"
              checked={ctx.plainModifierRunes}
              onChange={(e) => {
                const on = e.target.checked;
                setCtx((c) => ({ ...c, plainModifierRunes: on }));
              }}
            />
            Swift / Large as plain runes
          </label>
        </div>
      </aside>

      <section className="lab-main">
        <textarea
          className="lab-input"
          value={text}
          spellCheck={false}
          rows={3}
          onChange={(e) => {
            setText(e.target.value);
            setExampleId('');
          }}
          placeholder="orb[every 0.2s] cold split(4) bolt[small]"
        />
        <div className="lab-chips">
          {result.tokens.map((t, i) => (
            <span key={`${i}-${t.start}`} className={badIndices.has(i) ? 'bad' : ''} title={`rune ${i + 1}`}>
              <b>{i + 1}</b>
              {t.text}
            </span>
          ))}
          {result.tokens.length > 0 && (
            <button type="button" onClick={() => setText('')}>
              Clear
            </button>
          )}
        </div>

        <div className={`lab-verdict ${result.ok ? 'good' : 'bad'}`}>{result.ok ? 'Valid spell' : `${result.errors.length} rule${result.errors.length === 1 ? '' : 's'} broken`}</div>
        {runtime?.ok && onCast && (
          <button type="button" className="lab-cast" onClick={() => onCast({ label: text.trim(), compiled: runtime.compiled, notes: runtime.notes })}>
            Cast at dummies in Spell Studio
          </button>
        )}
        {runtime && !runtime.ok && (
          <p className="muted small">Not castable yet; the engine does not have: {runtime.unsupported.join(', ')}.</p>
        )}

        {result.errors.length > 0 && (
          <ul className="lab-errors">
            {result.errors.map((e, i) => (
              <li key={i}>
                <code>{e.rule}</code>
                {e.runeIndex >= 0 && <span className="lab-at">rune {e.runeIndex + 1}</span>}
                {e.message}
              </li>
            ))}
          </ul>
        )}

        {result.tree && (
          <>
            <h3>Sentence</h3>
            <p className="lab-sentence">{describeTree(result.tree)}</p>
            <h3>Bracket view</h3>
            <pre className="lab-bracket">{bracketTree(result.tree)}</pre>
            <h3>Tree</h3>
            <ul className="lab-tree">
              {result.tree.roots.map((n) => (
                <NodeRow key={n.runeIndex} node={n} />
              ))}
            </ul>
          </>
        )}

        <h3>Stats</h3>
        <dl className="lab-stats">
          <dt>Shapes</dt>
          <dd>{result.stats.shapes}</dd>
          <dt>Depth</dt>
          <dd>
            {result.stats.depth} / {ctx.maxDepth}
          </dd>
          <dt>Peak alive</dt>
          <dd className={result.stats.peakEntities > ctx.liveCap ? 'over' : ''}>
            {result.stats.peakEntities} / {ctx.liveCap}
          </dd>
          <dt>Lifetime total</dt>
          <dd>{result.stats.lifetimeEntities}</dd>
          <dt>Persistent</dt>
          <dd>{result.stats.persistent ? 'yes' : 'no'}</dd>
        </dl>

        <h3>
          <button type="button" onClick={() => setShowRules((v) => !v)}>
            {showRules ? 'Hide' : 'Show'} grammar rules
          </button>
        </h3>
        {showRules && (
          <ul className="lab-rules">
            {Object.values(RULES).map((r) => (
              <li key={r.id}>
                <code>{r.id}</code> {r.text}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
