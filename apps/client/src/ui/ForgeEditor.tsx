import {
  bracketTree,
  describeTree,
  forgeInsertPrice,
  formatAffix,
  HEAT,
  castingStarter,
  shownSlots,
  RULES,
  runeColor,
  runeDescription,
  runeKind,
  runeGlyph,
  runeName,
  rollLosses,
  sigilCapacity,
  sigilCastDelayShare,
  stashItemUids,
  type GrammarError,
  type InventoryMessage,
  type ItemUid,
  type RuneId,
  type RuneItem,
  type RuneKind,
  type RuneRef,
  type SigilCompile,
  type SigilItem,
} from '@rune/shared';
import { useEffect, useMemo, useState, type CSSProperties, type DragEvent, type MouseEvent } from 'react';
import { formatCooldown } from '../game/castTiming.js';
import { cssColor } from '../render/config.js';
import { buildPool, draftSigil, insertAt, keepAll, moveSlot, plainRef, refKey, refundOverflow, removeAt, resolveDraft, runeStock, sameDraft, type PlainEntry, type RolledEntry, type RuneOrigin } from './forge/draft.js';
import { ForgePreviewCanvas } from './forge/PreviewCanvas.js';
import { useHover } from './Inventory.js';
import { rollWithStored, tierColor } from './parts.js';
import { compileFor, itemByUid, sendCommand, useUi } from './store.js';
import { useMovablePanel } from './GamePanel.js';
import { tip } from './Tip.js';
import { useSigilCooldown } from './useSigilCooldown.js';
import './forge.css';
import { useTunables } from '../game/tunables.js';

/** Drag type for forge slots and pool runes; kept apart from item drags so the two never mix. */
const FORGE_DRAG = 'application/x-rune-forge';

const RULE_TEXT = new Map<string, string>(Object.values(RULES).map((r) => [r.id, r.text]));

const KIND_FILTERS: readonly { id: RuneKind | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'shape', label: 'Shapes' },
  { id: 'infusion', label: 'Infusions' },
  { id: 'shaper', label: 'Shapers' },
  { id: 'effect', label: 'Effects' },
  { id: 'trigger', label: 'Triggers' },
  { id: 'modifier', label: 'Modifiers' },
];

type SigilPlace = { item: SigilItem; where: 'equipped' | 'bag' | 'stash'; slot: number };

function sigilsOf(inv: InventoryMessage): SigilPlace[] {
  const out: SigilPlace[] = [];
  const seen = new Set<ItemUid>();
  const push = (uid: ItemUid | null, where: SigilPlace['where'], slot: number) => {
    if (uid === null || seen.has(uid)) return;
    const item = itemByUid(inv, uid);
    if (item?.kind !== 'sigil') return;
    seen.add(uid);
    out.push({ item, where, slot });
  };
  inv.sigils.forEach((uid, slot) => push(uid, 'equipped', slot));
  for (const uid of inv.inventory) push(uid, 'bag', -1);
  for (const uid of stashItemUids(inv.stash)) push(uid, 'stash', -1);
  return out;
}

/** The starter a sigil still is, as a subtitle under its own name; nothing once its runes changed. */
function starterNote(item: SigilItem): string | null {
  const def = castingStarter(item);
  return def && def.name !== item.name ? def.name : null;
}

/** What taking a rune out of the sigil costs it, or null when it comes out as it is. */
function weakening(item: RuneItem): string | null {
  const losses = rollLosses(item);
  if (losses.length === 0) return null;
  return `Taking this rune out weakens it: ${losses.map((l) => `${formatAffix(l.before)} becomes ${formatAffix(l.after)}`).join('; ')}`;
}

function runeStyle(id: RuneId): CSSProperties & Record<'--rune', string> {
  return { '--rune': cssColor(runeColor(id)) };
}

/** The rune glyph used in slots and the pool: its two-letter glyph in its kind's frame. */
function Glyph({ id }: { id: RuneId }) {
  return (
    <span className={`forge-glyph kind-${runeKind(id)}`} style={runeStyle(id)} aria-hidden="true">
      {runeGlyph(id)}
    </span>
  );
}

function OriginTag({ origin }: { origin: RuneOrigin }) {
  if (origin === 'stash') return <span className="forge-tag stash">in stash</span>;
  if (origin === 'sigil') return <span className="forge-tag kept">taken out</span>;
  return null;
}

type DragData = { kind: 'slot'; index: number } | { kind: 'pool'; key: string };

function parseDragData(raw: string): DragData | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null;
    const kind: unknown = Reflect.get(v, 'kind');
    if (kind === 'slot') {
      const index: unknown = Reflect.get(v, 'index');
      return typeof index === 'number' && Number.isInteger(index) && index >= 0 ? { kind, index } : null;
    }
    if (kind === 'pool') {
      const key: unknown = Reflect.get(v, 'key');
      return typeof key === 'string' ? { kind, key } : null;
    }
    return null;
  } catch {
    return null;
  }
}

function hover(item: RuneItem, e: MouseEvent, hint: string, warn: string | null = null): void {
  useHover.getState().set(item, e.clientX, e.clientY, warn ? { at: 'forge', hint, warn } : { at: 'forge', hint });
}

function unhover(): void {
  useHover.getState().set(null, 0, 0);
}

function ErrorList({ errors }: { errors: readonly GrammarError[] }) {
  return (
    <ul className="forge-errors">
      {errors.map((e, i) => (
        <li key={i}>
          <strong>{e.runeIndex >= 0 ? `Slot ${e.runeIndex + 1}: ` : ''}</strong>
          {e.message}
          {RULE_TEXT.get(e.rule) && <small>Rule: {RULE_TEXT.get(e.rule)}</small>}
        </li>
      ))}
    </ul>
  );
}

function Readout({ result, empty }: { result: SigilCompile; empty: boolean }) {
  if (empty) return <p className="muted">An empty sigil casts nothing. Add runes from the right, starting with a shape.</p>;
  if (!result.ok) {
    return (
      <>
        <p className="forge-verdict bad">
          This spell fizzles when cast, losing {Math.round(result.force * HEAT.dudHeatFraction)} {HEAT.displayName} each try.
        </p>
        <ErrorList errors={result.errors} />
      </>
    );
  }
  return (
    <>
      <p className="forge-sentence">{describeTree(result.tree)}</p>
      <p className="forge-bracket">{bracketTree(result.tree)}</p>
      <dl className="forge-stats">
        {result.persistent ? (
          <div>
            <dt>Spirit reserved</dt>
            <dd>{result.spirit}</dd>
          </div>
        ) : (
          <div>
            <dt>{HEAT.displayName} per cast</dt>
            <dd>{Math.round(result.force)}</dd>
          </div>
        )}
        <div>
          <dt>Most alive at once</dt>
          <dd>{result.peakEntities}</dd>
        </div>
      </dl>
      {result.notes.length > 0 && (
        <ul className="forge-notes">
          {result.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </>
  );
}

interface DraftState {
  uid: ItemUid;
  /** The sigil's slot uids when the draft began; a new inventory with other slots starts over. */
  base: string;
  refs: RuneRef[];
}

/**
 * The forge: pick a carried sigil, lay runes into its slots left to right from the ones the
 * character owns (bag first, then the account stash), see what the spell does and costs, try it
 * on a training dummy, and inscribe it for gold.
 */
export function ForgeEditor() {
  const open = useUi((s) => s.editorOpen);
  const { ref: panelRef, handleProps } = useMovablePanel('forge');
  const inv = useUi((s) => s.inventory);
  const classId = useUi((s) => s.classId);
  const uid = useUi((s) => s.editorUid);
  const forgeOpen = useUi((s) => s.station === 'forge');
  const bench = useUi((s) => s.editorAllowed && s.devTools);
  const inscribing = useUi((s) => s.inscribing !== null);
  const forgeError = useUi((s) => s.forgeError);
  const [draftState, setDraftState] = useState<DraftState | null>(null);
  const [filter, setFilter] = useState<RuneKind | 'all'>('all');
  const [dropAt, setDropAt] = useState<number | null>(null);

  // The server answers every inscribe; this only frees the button if the reply is lost with a dropped connection.
  useEffect(() => {
    if (!inscribing) return;
    const t = setTimeout(() => useUi.setState({ inscribing: null }), 5000);
    return () => clearTimeout(t);
  }, [inscribing]);
  useEffect(() => {
    if (!open) unhover();
  }, [open]);

  const places = useMemo(() => (inv ? sigilsOf(inv) : []), [inv]);
  const current = places.find((p) => p.item.uid === uid) ?? places.find((p) => p.where !== 'stash') ?? null;
  const sigil = current?.item ?? null;
  const cooldown = useSigilCooldown(sigil);
  const base = sigil ? sigil.slots.map((r) => r.uid).join(',') : '';
  const stock = useMemo(() => (inv ? runeStock(inv, bench && !forgeOpen) : null), [inv, bench, forgeOpen]);
  const free = stock?.bench === true;
  const rawDraft = useMemo(() => (sigil && draftState && draftState.uid === sigil.uid && draftState.base === base ? draftState.refs : sigil ? keepAll(sigil) : []), [sigil, draftState, base]);
  const resolution = useMemo(() => (sigil && stock ? resolveDraft(sigil, rawDraft, stock, forgeInsertPrice) : null), [sigil, stock, rawDraft]);
  const draft = resolution?.valid ?? [];
  const draftKey = draft.map(refKey).join(' ');
  const pool = useMemo(() => (sigil && stock ? buildPool(sigil, draft, stock) : null), [sigil, stock, draft]);
  const drafted = useMemo(() => (sigil && resolution ? draftSigil(sigil, resolution) : null), [sigil, resolution]);
  const tunables = useTunables((s) => s.version);
  const result = useMemo(() => (drafted && classId ? compileFor(drafted, classId) : null), [drafted, classId, tunables]);
  // The hover shows what each rune casts as (a whole starter's live numbers, or clamped rolls); the weakening warning reads the stored rolls.
  const shown = useMemo(() => (drafted ? shownSlots(drafted) : []), [drafted, tunables]);

  if (!open || !inv || !classId) return null;

  const setDraft = (refs: RuneRef[]) => {
    if (!sigil) return;
    setDraftState({ uid: sigil.uid, base, refs });
    if (useUi.getState().forgeError) useUi.setState({ forgeError: null });
  };
  const capacity = sigil ? sigilCapacity(sigil) : 0;
  const full = draft.length >= capacity;
  const locked = current?.where === 'stash';
  const changed = sigil ? !sameDraft(draft, keepAll(sigil)) : false;
  const price = free ? 0 : (resolution?.price ?? 0);
  const overflow = resolution && stock ? refundOverflow(inv, stock, resolution) : 0;
  const badSlots = new Set(result && !result.ok ? result.errors.map((e) => e.runeIndex).filter((i) => i >= 0) : []);

  const add = (ref: RuneRef | null, at = draft.length) => {
    if (!ref || locked) return;
    if (full) {
      useUi.getState().notify(`This sigil has ${capacity} slots`);
      return;
    }
    setDraft(insertAt(draft, ref, at));
  };
  const refForKey = (key: string): RuneRef | null => {
    if (!sigil || !pool) return null;
    if (key.startsWith('plain:')) {
      const entry = pool.plain.find((p) => `plain:${p.rune}` === key);
      return entry ? plainRef(sigil, draft, entry) : null;
    }
    return pool.rolled.find((r) => refKey(r.ref) === key)?.ref ?? null;
  };

  const onSlotDrop = (e: DragEvent, at: number) => {
    e.preventDefault();
    setDropAt(null);
    const data = parseDragData(e.dataTransfer.getData(FORGE_DRAG));
    if (!data || locked) return;
    if (data.kind === 'slot') setDraft(moveSlot(draft, data.index, Math.min(at, draft.length - 1)));
    else add(refForKey(data.key), Math.min(at, draft.length));
  };
  const onPoolDrop = (e: DragEvent) => {
    e.preventDefault();
    const data = parseDragData(e.dataTransfer.getData(FORGE_DRAG));
    if (data?.kind === 'slot') setDraft(removeAt(draft, data.index));
  };
  const dragOver = (e: DragEvent, at?: number) => {
    if (!e.dataTransfer.types.includes(FORGE_DRAG)) return;
    e.preventDefault();
    if (at !== undefined && dropAt !== at) setDropAt(at);
  };
  const startDrag = (e: DragEvent, data: DragData) => {
    e.dataTransfer.setData(FORGE_DRAG, JSON.stringify(data));
    e.dataTransfer.effectAllowed = 'move';
    unhover();
  };

  let saveReason: string | null = null;
  if (!sigil) saveReason = 'Pick a sigil';
  else if (locked) saveReason = 'Take the sigil out of the stash first';
  else if (!forgeOpen && !free) saveReason = 'Only at the forge in town';
  else if (!changed) saveReason = 'Nothing changed yet';
  else if (price > inv.gold) saveReason = `Needs ${price - inv.gold} more gold`;
  else if (inscribing) saveReason = 'Inscribing';

  // Building in steps is allowed, so a spell that fizzles can still be saved; the button says so.
  const fizzles = draft.length > 0 && result !== null && !result.ok;
  const inscribeLabel = inscribing ? 'Inscribing' : `${fizzles ? 'Inscribe anyway' : 'Inscribe'}${price > 0 ? ` for ${price} gold` : ''}${fizzles ? ' (fizzles)' : ''}`;

  const save = () => {
    if (!sigil || saveReason) return;
    const attempt = useUi.getState().startInscribe();
    sendCommand({ t: 'inscribe', uid: sigil.uid, base: sigil.slots.map((r) => r.uid), slots: draft, attempt });
  };

  const plainShown = (pool?.plain ?? []).filter((p) => filter === 'all' || runeKind(p.rune) === filter);
  const rolledShown = (pool?.rolled ?? []).filter((r) => filter === 'all' || runeKind(r.item.rune) === filter);
  const poolEmpty = !pool || pool.plain.length + pool.rolled.length === 0;
  const filterLabel = KIND_FILTERS.find((f) => f.id === filter)?.label.toLowerCase() ?? 'runes';

  return (
    <section ref={panelRef} className="panel forge" aria-label="Forge">
      <header className="forge-head" {...handleProps}>
        <h2>Forge</h2>
        <span className="muted">
          {free ? "Builders' bench: runes are free and come out bound" : 'Runes come from your bag first, then the stash'} · <span className="gold">{inv.gold} gold</span>
        </span>
        <button type="button" className="close" onClick={() => useUi.setState({ editorOpen: false })} aria-label="Close forge">
          ×
        </button>
      </header>

      <div className="forge-body">
        <nav className="forge-sigils" aria-label="Your sigils">
          <h3>Sigils</h3>
          {places.length === 0 && <p className="muted">You carry no sigils.</p>}
          {places.map((p) => (
            <button
              key={p.item.uid}
              type="button"
              className={`bare forge-sigil${p.item.uid === sigil?.uid ? ' active' : ''}${p.where === 'stash' ? ' locked' : ''}`}
              style={{ color: tierColor(p.item) }}
              onClick={() => useUi.setState({ editorUid: p.item.uid, forgeError: null })}
              data-link-uid={p.item.uid}
              {...tip(p.where === 'stash' ? 'Take it out of the stash first' : null)}
            >
              <span className="forge-sigil-where">{p.where === 'equipped' ? <kbd>{p.slot + 1}</kbd> : p.where === 'stash' ? 'stash' : 'bag'}</span>
              <span className="forge-sigil-name">
                {p.item.name}
                {starterNote(p.item) && <small className="forge-sigil-starter">{starterNote(p.item)}</small>}
              </span>
              <span className="forge-sigil-runes muted">
                {p.item.slots.length}/{sigilCapacity(p.item)}
              </span>
            </button>
          ))}
        </nav>

        <div className="forge-bench">
          {sigil && result && resolution ? (
            <>
              <div className="forge-title">
                <h3 style={{ color: tierColor(sigil) }}>{sigil.name}</h3>
                {starterNote(sigil) && <span className="forge-starter-note">{starterNote(sigil)}</span>}
                <span className="muted">
                  {capacity} slots{cooldown !== null && !(result.ok && result.persistent) && <> · Cooldown {formatCooldown(cooldown)}</>}
                  {sigil.corrupted ? ' · corrupted' : ''}
                </span>
              </div>
              {locked && <p className="forge-warn">This sigil is in the stash. Take it out of the stash first to inscribe it.</p>}

              <ol className="forge-slots" aria-label="Rune slots, read left to right">
                {Array.from({ length: capacity }, (_, i) => {
                  const slot = resolution.slots[i];
                  const cls = ['forge-slot', slot ? 'filled' : 'empty', badSlots.has(i) ? 'bad' : '', dropAt === i ? 'drop' : ''].filter(Boolean).join(' ');
                  if (!slot) {
                    return (
                      <li key={`empty-${i}`} className={cls} onDragOver={(e) => dragOver(e, i)} onDragLeave={() => setDropAt(null)} onDrop={(e) => onSlotDrop(e, i)}>
                        <span className="forge-slot-num">{i + 1}</span>
                      </li>
                    );
                  }
                  const rolled = slot.item.affixes.length > 0;
                  // Only a rune already in the sigil can lose rolls on the way out; a new one came in within the table.
                  const weakens = slot.origin === 'sigil' ? weakening(slot.item) : null;
                  const live = shown[i];
                  const own = live && live !== slot.item ? live.affixes.map((a) => rollWithStored(a, slot.item)).filter((t) => t.includes('(rune: ')) : [];
                  const hint = `Click to take it out · Drag to move it${slot.origin === 'stash' ? ' · From the stash' : ''}${own.length > 0 ? ` · Casts as ${own.join('; ')}` : ''}`;
                  return (
                    <li key={`${refKey(slot.ref)}-${i}`} className={cls} onDragOver={(e) => dragOver(e, i)} onDragLeave={() => setDropAt(null)} onDrop={(e) => onSlotDrop(e, i)}>
                      <button
                        type="button"
                        className="bare"
                        draggable={!locked}
                        disabled={locked}
                        onDragStart={(e) => startDrag(e, { kind: 'slot', index: i })}
                        onClick={() => {
                          unhover();
                          setDraft(removeAt(draft, i));
                        }}
                        onMouseEnter={(e) => hover(shown[i] ?? slot.item, e, hint, weakens)}
                        onMouseMove={(e) => hover(shown[i] ?? slot.item, e, hint, weakens)}
                        onMouseLeave={unhover}
                        data-link-uid={slot.item.uid >= 0 ? slot.item.uid : undefined}
                        aria-label={`Slot ${i + 1}: ${runeName(slot.item.rune)}${rolled ? ', rolled' : ''}${weakens ? `. ${weakens}` : ''}`}
                      >
                        <span className="forge-slot-num">{i + 1}</span>
                        <Glyph id={slot.item.rune} />
                        <span className="forge-slot-name">{runeName(slot.item.rune)}</span>
                        <span className="forge-slot-marks">
                          {rolled && <i className="mark rolled" />}
                          {slot.item.bound && <i className="mark bound" />}
                          {weakens && <i className="mark weakens" />}
                          {slot.origin === 'stash' && <i className="mark stash" />}
                          {slot.price > 0 && <span className="forge-price">{slot.price}g</span>}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>

              <div className="forge-readout">
                <Readout result={result} empty={draft.length === 0} />
              </div>

              <div className="forge-foot">
                <ForgePreviewCanvas classId={classId} spellKey={`${sigil.uid}:${draftKey}`} compiled={draft.length > 0 ? result : null} castDelayShare={sigilCastDelayShare(sigil)} />
                <div className="forge-save">
                  {resolution.refunds.length > 0 && <p className="muted">Comes back out: {resolution.refunds.map((r) => runeName(r.rune)).join(', ')}</p>}
                  {resolution.refundWeakened.length > 0 && (
                    <p className="forge-warn">
                      {resolution.refundWeakened.map((l) => `${runeName(l.rune)}: ${formatAffix(l.before)} becomes ${formatAffix(l.after)}`).join('; ')}. Rolls past what a drop can have only hold inside a sigil.
                    </p>
                  )}
                  {resolution.benchGone > 0 && <p className="muted">Bench runes taken out are gone: {resolution.benchGone}</p>}
                  {overflow > 0 && (
                    <p className="forge-warn">
                      Your bag is full: {overflow} {overflow === 1 ? 'rune goes' : 'runes go'} to pending until you make room.
                    </p>
                  )}
                  <p className="forge-cost">
                    {free ? 'Free on the bench' : price > 0 ? <>Costs <span className="gold">{price} gold</span> (runes kept or taken out are free)</> : 'No gold needed'}
                  </p>
                  <div className="forge-actions">
                    <button type="button" className={`forge-inscribe${fizzles ? ' fizzles' : ''}`} disabled={saveReason !== null} onClick={save}>
                      {inscribeLabel}
                    </button>
                    <button type="button" disabled={!changed || inscribing} onClick={() => setDraft(keepAll(sigil))}>
                      Reset
                    </button>
                  </div>
                  {saveReason && changed && !inscribing && <p className="muted">{saveReason}</p>}
                  {forgeError && <p className="forge-warn">The forge refused: {forgeError}</p>}
                </div>
              </div>
            </>
          ) : (
            <p className="muted">Pick a sigil on the left.</p>
          )}
        </div>

        <aside className="forge-pool" aria-label="Your runes" onDragOver={(e) => dragOver(e)} onDrop={onPoolDrop}>
          <h3>Runes</h3>
          <div className="forge-filters" role="tablist">
            {KIND_FILTERS.map((f) => (
              <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
          {poolEmpty && <p className="muted">You own no runes. They drop from monsters; plain ones stack, rolled ones carry affixes.</p>}
          {!poolEmpty && plainShown.length + rolledShown.length === 0 && <p className="muted">No {filterLabel} to add. Pick another kind above.</p>}
          {plainShown.length > 0 && (
            <>
              <h4>Plain</h4>
              <ul className="forge-list">
                {plainShown.map((p) => (
                  <PlainRow key={p.rune} entry={p} disabled={locked || full} onAdd={() => sigil && add(plainRef(sigil, draft, p))} onDrag={(e) => startDrag(e, { kind: 'pool', key: `plain:${p.rune}` })} />
                ))}
              </ul>
            </>
          )}
          {rolledShown.length > 0 && (
            <>
              <h4>Rolled</h4>
              <ul className="forge-list">
                {rolledShown.map((r) => (
                  <RolledRow key={refKey(r.ref)} entry={r} free={free} disabled={locked || full} onAdd={() => add(r.ref)} onDrag={(e) => startDrag(e, { kind: 'pool', key: refKey(r.ref) })} />
                ))}
              </ul>
            </>
          )}
          <p className="forge-hint muted">Click a rune to add it at the end, or drag it onto a slot. Drag a slot back here to take it out.</p>
        </aside>
      </div>
    </section>
  );
}

/**
 * How many of a plain rune can go in, and where they come from. The count is the total; the tags
 * say how much of it is not in the bag, so "x3 · 1 taken out · 2 in stash" reads without guessing.
 */
function PlainRow({ entry, disabled, onAdd, onDrag }: { entry: PlainEntry; disabled: boolean; onAdd: () => void; onDrag: (e: DragEvent) => void }) {
  const count = entry.loose + entry.bag + entry.stash;
  const sample: RuneItem = { uid: -1, kind: 'rune', tier: 'common', name: `${runeName(entry.rune)} Rune`, ilvl: 1, rune: entry.rune, count: 1, affixes: [] };
  const hint = entry.loose > 0 ? 'Click to put it back (free)' : entry.bag > 0 ? 'Click to add from your bag' : 'Click to add from the stash';
  return (
    <li>
      <button
        type="button"
        className="bare forge-rune"
        disabled={disabled}
        draggable={!disabled}
        onDragStart={onDrag}
        onClick={() => {
          unhover();
          onAdd();
        }}
        onMouseEnter={(e) => hover(sample, e, hint)}
        onMouseMove={(e) => hover(sample, e, hint)}
        onMouseLeave={unhover}
      >
        <Glyph id={entry.rune} />
        <span className="forge-rune-text">
          <span className="forge-rune-name">{runeName(entry.rune)}</span>
          <span className="forge-rune-desc">{runeDescription(entry.rune)}</span>
        </span>
        <span className="forge-rune-count">
          <span>{entry.unlimited ? 'free' : `x${count}`}</span>
          {entry.loose > 0 && (
            <span className="forge-tag kept">
              {entry.loose} taken out
            </span>
          )}
          {entry.stash > 0 && (
            <span className="forge-tag stash">
              {entry.stash} in stash
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

function RolledRow({ entry, free, disabled, onAdd, onDrag }: { entry: RolledEntry; free: boolean; disabled: boolean; onAdd: () => void; onDrag: (e: DragEvent) => void }) {
  const hint =
    entry.origin === 'sigil'
      ? 'Click to put it back (free, keeps its rolls)'
      : free
        ? 'Click to add it (free)'
        : `Click to add · ${forgeInsertPrice(entry.item)} gold to inscribe`;
  return (
    <li>
      <button
        type="button"
        className="bare forge-rune rolled"
        disabled={disabled}
        draggable={!disabled}
        onDragStart={onDrag}
        onClick={() => {
          unhover();
          onAdd();
        }}
        onMouseEnter={(e) => hover(entry.item, e, hint)}
        onMouseMove={(e) => hover(entry.item, e, hint)}
        onMouseLeave={unhover}
        data-link-uid={entry.item.uid}
      >
        <Glyph id={entry.item.rune} />
        <span className="forge-rune-text">
          <span className="forge-rune-name" style={{ color: tierColor(entry.item) }}>
            {entry.item.name}
          </span>
          <span className="forge-rune-desc">{runeDescription(entry.item.rune)}</span>
        </span>
        <span className="forge-rune-count">
          <i className="mark rolled" />
          {entry.item.bound && <i className="mark bound" />}
          <OriginTag origin={entry.origin} />
        </span>
      </button>
    </li>
  );
}
