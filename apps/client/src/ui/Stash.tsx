import {
  AFFIX_IDS,
  AFFIXES,
  describeTree,
  formatAffix,
  generalTab,
  isRuneAffixId,
  isStashTabName,
  ITEM_TIERS,
  matchingStarter,
  placements,
  RUNE_IDS,
  RUNE_SORT_KEYS,
  runeColor,
  runeGlyph,
  runeKind,
  runeName,
  SIGIL_SORT_KEYS,
  sigilCapacity,
  STASH,
  STASH_COLORS,
  STASH_TABS,
  type AffixId,
  type ClassId,
  type InventoryMessage,
  type Item,
  type ItemTier,
  type ItemUid,
  type RuneId,
  type RuneItem,
  type RuneKind,
  type RuneSortKey,
  type SigilItem,
  type SigilSortKey,
  type StashColorId,
  type StashTabRef,
} from '@rune/shared';
import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { cssColor } from '../render/config.js';
import { ItemIcon } from './icons.js';
import { ItemGrid, QUICK_KEY, useDrag, useHover } from './Inventory.js';
import { DRAG_TYPE, dropAction, parseDrag, type DragPayload, type ItemPlace } from './itemActions.js';
import { tierColor } from './parts.js';
import { compileFor, itemByUid, sendCommand, useUi } from './store.js';
import { useStashView, type SigilContents } from './stashView.js';
import { activeStation } from './stations.js';
import { useMovablePanel } from './GamePanel.js';
import { tip } from './Tip.js';
import './forge.css';
import './stash.css';
import { formatCooldown, sigilCooldown, useCastTiming } from '../game/castTiming.js';

const RUNE_SORT_LABELS: Record<RuneSortKey, string> = { rune: 'Rune', kind: 'Kind', tier: 'Tier', ilvl: 'Item level', affix: 'Affix value' };
const SIGIL_SORT_LABELS: Record<SigilSortKey, string> = { tier: 'Tier', ilvl: 'Item level', slots: 'Slots', name: 'Name' };
const KINDS: readonly { id: RuneKind; label: string }[] = [
  { id: 'shape', label: 'Shapes' },
  { id: 'infusion', label: 'Infusions' },
  { id: 'shaper', label: 'Shapers' },
  { id: 'effect', label: 'Effects' },
  { id: 'trigger', label: 'Triggers' },
  { id: 'modifier', label: 'Modifiers' },
];
const TIER_LABELS: Record<ItemTier, string> = { common: 'Common', magic: 'Magic', rare: 'Rare', relic: 'Relic' };
const CONTENTS: readonly { id: SigilContents; label: string }[] = [
  { id: 'all', label: 'Any contents' },
  { id: 'blank', label: 'Blank' },
  { id: 'runes', label: 'Holds runes' },
  { id: 'starter', label: 'Starter' },
];
const RUNE_AFFIXES: readonly AffixId[] = AFFIX_IDS.filter((id) => isRuneAffixId(id));

function affixLabel(id: AffixId): string {
  return AFFIXES[id].text.replace('{v}', '#');
}

function colorHex(id: StashColorId): string {
  return STASH_COLORS.find((c) => c.id === id)?.hex ?? '#6e6a62';
}

function isRuneSortKey(v: string): v is RuneSortKey {
  return RUNE_SORT_KEYS.some((k) => k === v);
}
function isSigilSortKey(v: string): v is SigilSortKey {
  return SIGIL_SORT_KEYS.some((k) => k === v);
}
function isTier(v: string): v is ItemTier {
  return ITEM_TIERS.some((t) => t === v);
}
function isKind(v: string): v is RuneKind {
  return KINDS.some((k) => k.id === v);
}
function isRune(v: string): v is RuneId {
  return RUNE_IDS.some((r) => r === v);
}
function isContents(v: string): v is SigilContents {
  return CONTENTS.some((c) => c.id === v);
}

/** Selects and buttons keep focus after use, and a focused select swallows game keys; hand focus back. */
function blurAfter(e: { currentTarget: HTMLElement }): void {
  e.currentTarget.blur();
}

function blurSelect(e: { target: EventTarget }): void {
  if (e.target instanceof HTMLSelectElement) e.target.blur();
}

function draggedItem(e: DragEvent): { payload: DragPayload; item: Item; inv: InventoryMessage; cls: ClassId } | null {
  const payload = parseDrag(e.dataTransfer.getData(DRAG_TYPE));
  const { inventory, classId } = useUi.getState();
  const item = payload && inventory ? itemByUid(inventory, payload.uid) : undefined;
  return payload && item && inventory && classId ? { payload, item, inv: inventory, cls: classId } : null;
}

/** Drops on a stash place: whatever dropAction says, sent as a command. */
function dropOn(e: DragEvent, target: ItemPlace): void {
  e.preventDefault();
  useDrag.setState({ drag: null });
  const d = draggedItem(e);
  if (!d) return;
  const msg = dropAction(d.inv, d.item, d.payload, target, d.cls);
  if (msg) sendCommand(msg);
}

/** Whether the item being dragged would be taken by `target`, for the drop highlight. */
function useAccepts(target: ItemPlace): boolean {
  const drag = useDrag((s) => s.drag);
  const inv = useUi((s) => s.inventory);
  const cls = useUi((s) => s.classId);
  const item = drag && inv ? itemByUid(inv, drag.uid) : undefined;
  return drag !== null && item !== undefined && inv !== null && cls !== null && dropAction(inv, item, drag, target, cls) !== null;
}

// Tab bar -----------------------------------------------------------------------------------

function TabButton({ tab, label, color, count, active }: { tab: StashTabRef; label: string; color: string | null; count: number; active: boolean }) {
  const [over, setOver] = useState(false);
  const accepts = useAccepts({ at: 'tabLabel', tab });
  const hoverTimer = useRef<number | null>(null);
  const clear = () => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  useEffect(() => clear, []);
  const style: CSSProperties & Record<'--tab', string> = { '--tab': color ?? '#8a7a5a' };
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`bare stash-tab${active ? ' active' : ''}${over ? (accepts ? ' drop-ok' : ' drop-no') : ''}${color ? '' : ' fixed'}`}
      style={style}
      onClick={() => useStashView.setState({ tab })}
      onDragEnter={() => {
        setOver(true);
        // Hovering a tab while dragging opens it, PoE style, so the item can be placed on a cell.
        clear();
        hoverTimer.current = window.setTimeout(() => useStashView.setState({ tab }), 450);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_TYPE)) e.preventDefault();
      }}
      onDragLeave={() => {
        setOver(false);
        clear();
      }}
      onDrop={(e) => {
        setOver(false);
        clear();
        dropOn(e, { at: 'tabLabel', tab });
      }}
      {...tip(typeof tab === 'number' ? `${label}: drop an item here to put it in this tab` : null)}
    >
      <span className="stash-tab-name">{label}</span>
      <span className="stash-tab-count">{count}</span>
    </button>
  );
}

function BuyTab({ inv }: { inv: InventoryMessage }) {
  const [asking, setAsking] = useState(false);
  const price = inv.stashTabPrice;
  // A new tab arriving (or the cap) ends the question.
  useEffect(() => setAsking(false), [inv.stash.general.length]);
  if (price === null) return null;
  const short = inv.gold < price;
  if (asking)
    return (
      <span className="stash-buy-ask">
        {/* One flex item: the row's gap would otherwise sit between the price and its question mark. */}
        <span>
          Tab {inv.stash.general.length + 1} for <span className="gold">{price} gold</span>?
        </span>
        <button type="button" onClick={() => sendCommand({ t: 'buyStashTab' })}>
          Buy
        </button>
        <button type="button" onClick={() => setAsking(false)}>
          No
        </button>
      </span>
    );
  return (
    // React drops mouse events on a disabled button, and the tip matters most then, so it sits on a wrapper.
    <span className="tip-host" {...tip(short ? `You have ${inv.gold} gold` : `${inv.stash.general.length} of ${STASH_TABS.maxGeneral} general tabs`)}>
      <button type="button" className="stash-buy" disabled={short} onClick={() => setAsking(true)}>
        + Buy tab ({price} gold)
      </button>
    </span>
  );
}

function TabBar({ inv, current }: { inv: InventoryMessage; current: StashTabRef }) {
  return (
    <div className="stash-tabs" role="tablist" aria-label="Stash tabs">
      {inv.stash.general.map((t) => (
        <TabButton key={t.id} tab={t.id} label={t.name} color={colorHex(t.color)} count={placements(t.cells, STASH).length} active={current === t.id} />
      ))}
      <span className="stash-tab-gap" aria-hidden="true" />
      <TabButton tab="runes" label="Runes" color={null} count={inv.stash.runes.list.length} active={current === 'runes'} />
      <TabButton tab="sigils" label="Sigils" color={null} count={inv.stash.sigils.list.length} active={current === 'sigils'} />
      <BuyTab inv={inv} />
    </div>
  );
}

// Rename and recolour ---------------------------------------------------------------------------

/** Trims and collapses spaces, the way the server wants a name. */
function cleanName(v: string): string {
  return v.replace(/\s+/g, ' ').trim();
}

function TabEditor({ tab, name, color, onClose }: { tab: number; name: string; color: StashColorId; onClose: () => void }) {
  const [text, setText] = useState(name);
  const [pick, setPick] = useState<StashColorId>(color);
  const clean = cleanName(text);
  const ok = isStashTabName(clean);
  const save = () => {
    if (!ok) return;
    sendCommand({ t: 'editStashTab', tab, name: clean, color: pick });
    onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  };
  return (
    <div className="stash-editor" role="dialog" aria-label="Edit stash tab">
      <label>
        <span>Name</span>
        <input autoFocus value={text} maxLength={STASH_TABS.nameMax} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} spellCheck={false} />
      </label>
      <div className="stash-swatches" role="radiogroup" aria-label="Tab colour">
        {STASH_COLORS.map((c) => (
          <button key={c.id} type="button" role="radio" aria-checked={pick === c.id} className={`bare stash-swatch${pick === c.id ? ' on' : ''}`} style={{ background: c.hex }} aria-label={c.label} {...tip(c.label)} onClick={() => setPick(c.id)} />
        ))}
      </div>
      {!ok && <p className="stash-editor-why">1 to {STASH_TABS.nameMax} letters, digits, spaces or . , ' ! ? &amp; ( ) + # : -</p>}
      <div className="stash-editor-actions">
        <button type="button" onClick={save} disabled={!ok}>
          Save
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// List rows -------------------------------------------------------------------------------------

/**
 * One item in a list tab. It drags like a grid item, shows the tooltip, and a right-click or
 * ctrl+click (cmd+click) takes it to the bag. `onShift` handles a shift+click (splitting a stack).
 */
function ListRow({ item, place, className, children, onShift }: { item: Item; place: ItemPlace; className: string; children: ReactNode; onShift?: (() => void) | undefined }) {
  const setHover = useHover((h) => h.set);
  const dragging = useDrag((d) => d.drag?.uid === item.uid);
  const quick = (e: MouseEvent) => {
    e.preventDefault();
    setHover(null, 0, 0);
    sendCommand({ t: 'quickMove', uid: item.uid, tab: null });
  };
  return (
    <button
      type="button"
      className={`bare stash-row ${className}${dragging ? ' dragging' : ''}`}
      draggable
      onDragStart={(e) => {
        const payload: DragPayload = { uid: item.uid, from: place, grab: { x: 0, y: 0 } };
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload));
        e.dataTransfer.effectAllowed = 'move';
        useDrag.setState({ drag: payload });
        setHover(null, 0, 0);
      }}
      onDragEnd={() => useDrag.setState({ drag: null })}
      onMouseEnter={(e) => setHover(item, e.clientX, e.clientY, place)}
      onMouseMove={(e) => setHover(item, e.clientX, e.clientY, place)}
      onMouseLeave={() => setHover(null, 0, 0)}
      onContextMenu={quick}
      data-link-uid={item.uid}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey) quick(e);
        else if (e.shiftKey && onShift) onShift();
      }}
      aria-label={item.name}
    >
      {children}
    </button>
  );
}

/** A list tab's scrolling body, which also takes drops. */
function DropList({ target, children, empty }: { target: ItemPlace; children: ReactNode; empty: string | null }) {
  const [over, setOver] = useState(false);
  const accepts = useAccepts(target);
  return (
    <div
      className={`stash-list${over ? (accepts ? ' drop-ok' : ' drop-no') : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget instanceof Node ? e.relatedTarget : null)) setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        dropOn(e, target);
      }}
    >
      {empty ? <p className="stash-empty">{empty}</p> : children}
    </div>
  );
}

function Glyph({ id }: { id: RuneId }) {
  const style: CSSProperties & Record<'--rune', string> = { '--rune': cssColor(runeColor(id)) };
  return (
    <span className={`forge-glyph kind-${runeKind(id)}`} style={style} aria-hidden="true">
      {runeGlyph(id)}
    </span>
  );
}

// The rune tab ----------------------------------------------------------------------------------

function runeMatches(r: RuneItem, view: ReturnType<typeof useStashView.getState>): boolean {
  if (view.runeFilter !== 'all' && r.rune !== view.runeFilter) return false;
  if (view.kindFilter !== 'all' && runeKind(r.rune) !== view.kindFilter) return false;
  if (view.runeTierFilter !== 'all' && r.tier !== view.runeTierFilter) return false;
  const q = view.affixSearch.trim().toLowerCase();
  return q === '' || r.affixes.some((a) => formatAffix(a).toLowerCase().includes(q));
}

function SplitRow({ item, onClose }: { item: RuneItem; onClose: () => void }) {
  const [n, setN] = useState(Math.floor(item.count / 2) || 1);
  const valid = Number.isInteger(n) && n >= 1 && n <= item.count;
  const take = () => {
    if (!valid) return;
    sendCommand({ t: 'takeRunes', uid: item.uid, count: n, to: null });
    onClose();
  };
  return (
    <div className="stash-split">
      <span>
        Take from {item.name} ({item.count}):
      </span>
      <input
        type="number"
        min={1}
        max={item.count}
        value={n}
        autoFocus
        onChange={(e) => setN(Number(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') take();
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <button type="button" onClick={take} disabled={!valid}>
        To bag
      </button>
      <button type="button" onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}

function RuneTabView({ inv }: { inv: InventoryMessage }) {
  const view = useStashView();
  const [split, setSplit] = useState<ItemUid | null>(null);
  const runes = inv.stash.runes.list.flatMap((u) => {
    const it = itemByUid(inv, u);
    return it?.kind === 'rune' ? [it] : [];
  });
  const shown = runes.filter((r) => runeMatches(r, view));
  const units = runes.reduce((n, r) => n + r.count, 0);
  const splitting = runes.find((r) => r.uid === split);
  const present = RUNE_IDS.filter((id) => runes.some((r) => r.rune === id));
  return (
    <>
      <div className="stash-toolbar" onChange={blurSelect}>
        <span className="stash-title">Runes</span>
        <span className="muted">
          {runes.length} / {STASH_TABS.runeCap} · {units} runes
        </span>
        <span className="stash-spacer" />
        <select aria-label="Sort runes by" value={view.runeSort} onChange={(e) => (isRuneSortKey(e.target.value) ? useStashView.setState({ runeSort: e.target.value }) : undefined)}>
          {RUNE_SORT_KEYS.map((k) => (
            <option key={k} value={k}>
              {RUNE_SORT_LABELS[k]}
            </option>
          ))}
        </select>
        {view.runeSort === 'affix' && (
          <select aria-label="Affix to sort by" value={view.runeSortAffix} onChange={(e) => (isRuneAffixId(e.target.value) ? useStashView.setState({ runeSortAffix: e.target.value }) : undefined)}>
            {RUNE_AFFIXES.map((id) => (
              <option key={id} value={id}>
                {affixLabel(id)}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          disabled={runes.length < 2}
          onClick={(e) => {
            blurAfter(e);
            sendCommand({ t: 'sortStash', tab: 'runes', key: view.runeSort, affix: view.runeSort === 'affix' ? view.runeSortAffix : null });
          }}
        >
          Sort
        </button>
      </div>
      <div className="stash-filters" onChange={blurSelect}>
        <select aria-label="Rune" value={view.runeFilter} onChange={(e) => useStashView.setState({ runeFilter: isRune(e.target.value) ? e.target.value : 'all' })}>
          <option value="all">All runes</option>
          {present.map((id) => (
            <option key={id} value={id}>
              {runeName(id)}
            </option>
          ))}
        </select>
        <select aria-label="Kind" value={view.kindFilter} onChange={(e) => useStashView.setState({ kindFilter: isKind(e.target.value) ? e.target.value : 'all' })}>
          <option value="all">All kinds</option>
          {KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
        <select aria-label="Tier" value={view.runeTierFilter} onChange={(e) => useStashView.setState({ runeTierFilter: isTier(e.target.value) ? e.target.value : 'all' })}>
          <option value="all">All tiers</option>
          {ITEM_TIERS.map((t) => (
            <option key={t} value={t}>
              {TIER_LABELS[t]}
            </option>
          ))}
        </select>
        <input
          type="search"
          placeholder="Affix text"
          aria-label="Search affixes"
          value={view.affixSearch}
          onChange={(e) => useStashView.setState({ affixSearch: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              e.currentTarget.blur();
            }
          }}
        />
        {shown.length !== runes.length && <span className="muted small">{shown.length} shown</span>}
      </div>
      {splitting && <SplitRow item={splitting} onClose={() => setSplit(null)} />}
      <DropList target={{ at: 'runeTab' }} empty={runes.length === 0 ? `No runes yet. ${QUICK_KEY}+click runes in your bag, or drag them here.` : shown.length === 0 ? 'No rune matches these filters.' : null}>
        {shown.map((r) => (
          <ListRow key={r.uid} item={r} place={{ at: 'runeTab' }} className="stash-rune-row" onShift={r.affixes.length === 0 && r.count > 1 ? () => setSplit(r.uid) : undefined}>
            <Glyph id={r.rune} />
            <span className="stash-row-name" style={{ color: tierColor(r) }}>
              {r.name}
              {r.affixes.length === 0 && <span className="stash-count"> x{r.count}</span>}
            </span>
            <span className="stash-row-affixes">{r.affixes.length === 0 ? 'Plain' : r.affixes.map(formatAffix).join(' · ')}</span>
            <span className="stash-row-ilvl">ilvl {r.ilvl}</span>
          </ListRow>
        ))}
      </DropList>
    </>
  );
}

// The sigil tab ---------------------------------------------------------------------------------

/** Compiles are the slow part of the list, so each sigil's sentence is kept until its runes change. */
const SENTENCES = new Map<string, { text: string; persistent: boolean }>();

function sentenceOf(item: SigilItem, classId: ClassId): string {
  return compiledView(item, classId).text;
}

/** Aura and Bond never wait for the cast cooldown, so their row leaves it out. */
function isPersistent(item: SigilItem, classId: ClassId): boolean {
  return compiledView(item, classId).persistent;
}

function compiledView(item: SigilItem, classId: ClassId): { text: string; persistent: boolean } {
  if (item.slots.length === 0) return { text: 'Blank: inscribe it at the forge.', persistent: false };
  const key = `${classId}|${item.uid}|${item.slots.map((r) => `${r.uid}:${r.rune}:${r.affixes.map((a) => `${a.id}=${a.value}`).join(',')}`).join(';')}|${item.affixes.map((a) => `${a.id}=${a.value}`).join(',')}`;
  const hit = SENTENCES.get(key);
  if (hit !== undefined) return hit;
  const result = compileFor(item, classId);
  const text = result.ok ? describeTree(result.tree) || 'Does nothing.' : `Fizzles: ${result.errors.map((e) => e.message).join('; ')}`;
  const view = { text, persistent: result.ok && result.persistent };
  // Uids are reissued per room, so old keys pile up; a small cap is plenty for one list.
  if (SENTENCES.size > 600) SENTENCES.clear();
  SENTENCES.set(key, view);
  return view;
}

function sigilMatches(s: SigilItem, tier: ItemTier | 'all', contents: SigilContents): boolean {
  if (tier !== 'all' && s.tier !== tier) return false;
  if (contents === 'blank') return s.slots.length === 0;
  if (contents === 'runes') return s.slots.length > 0;
  if (contents === 'starter') return matchingStarter(s) !== undefined;
  return true;
}

function SigilTabView({ inv }: { inv: InventoryMessage }) {
  const view = useStashView();
  const classId = useUi((s) => s.classId);
  const globalCooldown = useCastTiming((s) => s.globalSeconds);
  const castSpeed = useUi((s) => s.stats?.castSpeedMult ?? 1);
  const sigils = inv.stash.sigils.list.flatMap((u) => {
    const it = itemByUid(inv, u);
    return it?.kind === 'sigil' ? [it] : [];
  });
  const shown = sigils.filter((s) => sigilMatches(s, view.sigilTierFilter, view.sigilContents));
  if (!classId) return null;
  return (
    <>
      <div className="stash-toolbar" onChange={blurSelect}>
        <span className="stash-title">Sigils</span>
        <span className="muted">
          {sigils.length} / {STASH_TABS.sigilCap}
        </span>
        <span className="stash-spacer" />
        <select aria-label="Sort sigils by" value={view.sigilSort} onChange={(e) => (isSigilSortKey(e.target.value) ? useStashView.setState({ sigilSort: e.target.value }) : undefined)}>
          {SIGIL_SORT_KEYS.map((k) => (
            <option key={k} value={k}>
              {SIGIL_SORT_LABELS[k]}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={sigils.length < 2}
          onClick={(e) => {
            blurAfter(e);
            sendCommand({ t: 'sortStash', tab: 'sigils', key: view.sigilSort, affix: null });
          }}
        >
          Sort
        </button>
      </div>
      <div className="stash-filters" onChange={blurSelect}>
        <select aria-label="Tier" value={view.sigilTierFilter} onChange={(e) => useStashView.setState({ sigilTierFilter: isTier(e.target.value) ? e.target.value : 'all' })}>
          <option value="all">All tiers</option>
          {ITEM_TIERS.map((t) => (
            <option key={t} value={t}>
              {TIER_LABELS[t]}
            </option>
          ))}
        </select>
        <select aria-label="Contents" value={view.sigilContents} onChange={(e) => useStashView.setState({ sigilContents: isContents(e.target.value) ? e.target.value : 'all' })}>
          {CONTENTS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        {shown.length !== sigils.length && <span className="muted small">{shown.length} shown</span>}
      </div>
      <DropList target={{ at: 'sigilTab' }} empty={sigils.length === 0 ? `No sigils yet. ${QUICK_KEY}+click sigils in your bag, or drag them here.` : shown.length === 0 ? 'No sigil matches these filters.' : null}>
        {shown.map((s) => (
          <ListRow key={s.uid} item={s} place={{ at: 'sigilTab' }} className="stash-sigil-row">
            <span className="stash-sigil-icon">
              <ItemIcon item={s} size={34} />
            </span>
            <span className="stash-sigil-text">
              <span className="stash-row-name" style={{ color: tierColor(s) }}>
                {s.name}
              </span>
              <span className="stash-sigil-meta">
                {TIER_LABELS[s.tier]} · ilvl {s.ilvl} · {s.slots.length}/{sigilCapacity(s)} runes
                {!isPersistent(s, classId) && <> · Cooldown {formatCooldown(sigilCooldown(s, globalCooldown, castSpeed))}</>}
                {s.affixes.length > 0 && <> · {s.affixes.map(formatAffix).join(' · ')}</>}
              </span>
              <span className="stash-sigil-sentence">{sentenceOf(s, classId)}</span>
            </span>
          </ListRow>
        ))}
      </DropList>
    </>
  );
}

// The window ------------------------------------------------------------------------------------

function GeneralTabView({ inv, id, onEdit }: { inv: InventoryMessage; id: number; onEdit: () => void }) {
  const [selUid, setSelUid] = useState<ItemUid | null>(null);
  const tab = generalTab(inv.stash, id);
  if (!tab) return null;
  const used = placements(tab.cells, STASH).length;
  const style: CSSProperties & Record<'--tab', string> = { '--tab': colorHex(tab.color) };
  return (
    <>
      <div className="stash-toolbar" onChange={blurSelect}>
        <span className="stash-title general" style={style}>
          {tab.name}
        </span>
        <span className="muted">{used} items</span>
        <span className="stash-spacer" />
        <span className="tip-host" {...tip('Group by type, best first')}>
          <button type="button" onClick={() => sendCommand({ t: 'sortStash', tab: id, key: null, affix: null })} disabled={used === 0}>
            Sort
          </button>
        </span>
        <button type="button" onClick={onEdit}>
          Rename
        </button>
      </div>
      <div className="inv-bag stash-grid">
        <ItemGrid which={id} selUid={selUid} onSelect={(uid) => setSelUid(uid === selUid ? null : uid)} />
      </div>
    </>
  );
}

/** The account's shared stash, beside the bag while standing at the chest in town. */
export function StashWindow() {
  // The forge sits near the chest; its editor takes the stash's place on screen while it is open.
  const open = useUi((s) => activeStation(s) === 'stash');
  const inv = useUi((s) => s.inventory);
  const tab = useStashView((s) => s.tab);
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [open, tab]);
  // A row that unmounts under the mouse never sends mouseleave, so its tooltip would stay up.
  useEffect(() => useHover.getState().set(null, 0, 0), [tab]);
  const { ref, handleProps } = useMovablePanel('stash');
  if (!open || !inv) return null;
  // Another account (or a stash from before a purchase) may not have the tab last looked at.
  const current: StashTabRef = typeof tab === 'number' && !generalTab(inv.stash, tab) ? (inv.stash.general[0]?.id ?? 1) : tab;
  const editTab = typeof current === 'number' ? generalTab(inv.stash, current) : undefined;
  return (
    <section ref={ref} className="panel inv-window stash-window" aria-label="Stash">
      <header className="inv-header" {...handleProps}>
        <h2>Stash</h2>
        <span className="muted">
          shared by all your characters · <span className="gold">{inv.gold} gold</span>
        </span>
      </header>
      <TabBar inv={inv} current={current} />
      <div className="stash-pane">
        {typeof current === 'number' ? <GeneralTabView inv={inv} id={current} onEdit={() => setEditing(true)} /> : current === 'runes' ? <RuneTabView inv={inv} /> : <SigilTabView inv={inv} />}
        {editing && editTab && <TabEditor key={editTab.id} tab={editTab.id} name={editTab.name} color={editTab.color} onClose={() => setEditing(false)} />}
      </div>
      <footer className="inv-footer">
        <span>
          <kbd>{QUICK_KEY}</kbd>+click or <kbd>Right-click</kbd> to the bag and back
        </span>
        <span>
          <kbd>Drag</kbd> to place or onto a tab
        </span>
        {current === 'runes' && (
          <span>
            <kbd>Shift</kbd>+click split
          </span>
        )}
      </footer>
    </section>
  );
}
