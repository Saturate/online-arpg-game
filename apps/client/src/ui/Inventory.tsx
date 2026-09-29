import { BAG, categoryForSlot, isBound, sellPrice, TRADER, CLASSES, GEAR_SLOTS, itemSize, placements, STASH, STAT_LABELS, type GearSlot, type GridSize, type InventoryMessage, type Item, type ItemUid } from '@rune/shared';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import { create } from 'zustand';
import { ItemIcon, SlotSilhouette } from './icons.js';
import { compareGear, DRAG_TYPE, dropAction, dropRefusal, parseDrag, pendingOf, quickAction, replacedBy, type DragPayload, type ItemPlace } from './itemActions.js';
import { affixPips, placeTooltip, unusable } from './itemView.js';
import { ItemDetails, tierColor } from './parts.js';
import { spiritCost } from './spirit.js';
import { itemByUid, sendCommand, swapSkills, useUi } from './store.js';
import './inventory.css';

interface HoverState {
  item: Item | null;
  /** Where the hovered item sits, so bag gear can be compared against what it would replace. */
  place: ItemPlace | null;
  x: number;
  y: number;
  set: (item: Item | null, x: number, y: number, place?: ItemPlace | null) => void;
}

/** Hovered item for the floating tooltip; kept out of the main store because it changes on every mouse move. */
export const useHover = create<HoverState>((set) => ({ item: null, place: null, x: 0, y: 0, set: (item, x, y, place = null) => set({ item, x, y, place }) }));

/**
 * The item being dragged, so every cell can light up if it would accept it. The browser only
 * exposes drag data on drop, so this mirrors it for the duration of the drag.
 */
const useDrag = create<{ drag: DragPayload | null }>(() => ({ drag: null }));

/** A good item waiting for a yes before it is dropped on the ground or sold to the shared shelf. */
const usePendingDrop = create<{ uid: ItemUid | null; sell: boolean }>(() => ({ uid: null, sell: false }));

/** Only relics ask before selling; everything else sells on the click, as a trader run is mostly junk. */
function asksBeforeSelling(item: Item): boolean {
  return item.tier === 'relic';
}

/**
 * Bag items that arrived since the player last looked: picked up, bought or a rune stack that grew.
 * Hovering one clears its mark. `baseline` is false until the first inventory of a room arrives,
 * because uids are reissued per room and everything would look new.
 */
const useFresh = create<{ uids: ReadonlySet<ItemUid>; baseline: boolean }>(() => ({ uids: new Set(), baseline: false }));

export function noteInventory(prev: InventoryMessage | null, next: InventoryMessage): void {
  const { uids, baseline } = useFresh.getState();
  if (!prev || !baseline) {
    useFresh.setState({ baseline: true });
    return;
  }
  const before = new Map(prev.items.map((i) => [i.uid, i]));
  const inBag = new Set(next.inventory);
  const fresh = new Set([...uids].filter((u) => inBag.has(u)));
  for (const item of next.items) {
    if (!inBag.has(item.uid)) continue;
    const old = before.get(item.uid);
    if (!old || (item.kind === 'rune' && old.kind === 'rune' && item.count > old.count)) fresh.add(item.uid);
  }
  useFresh.setState({ uids: fresh });
}

function unmarkFresh(uid: ItemUid): void {
  const { uids } = useFresh.getState();
  if (!uids.has(uid)) return;
  const next = new Set(uids);
  next.delete(uid);
  useFresh.setState({ uids: next });
}

/** Item uids are reissued per room, so a drag or drop prompt must not survive a room change. */
export function clearItemInteractions(): void {
  useDrag.setState({ drag: null });
  useFresh.setState({ uids: new Set(), baseline: false });
  usePendingDrop.setState({ uid: null, sell: false });
}

/** Drops a bag item on the ground; a rare or relic asks first, however it was dropped. */
export function requestDrop(uid: ItemUid): void {
  const item = itemByUid(useUi.getState().inventory, uid);
  if (!item) return;
  const refusal = dropRefusal(item);
  if (refusal) {
    useUi.getState().notify(refusal);
    return;
  }
  if (item.tier === 'rare' || item.tier === 'relic') {
    usePendingDrop.setState({ uid, sell: false });
    return;
  }
  sendCommand({ t: 'discard', uid });
}

function isTyping(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
}

function Comparison({ item }: { item: Item }) {
  const inv = useUi((s) => s.inventory);
  if (!inv || item.kind !== 'gear') return null;
  const current = replacedBy(inv, item);
  const deltas = compareGear(item, current);
  return (
    <section className="tt-compare">
      <h5>{current ? <>Compared with {current.name}</> : 'Fills an empty slot'}</h5>
      {deltas.length === 0 ? (
        <p className="muted">No stat change</p>
      ) : (
        <ul>
          {deltas.map((d) => (
            <li key={d.stat} className={d.delta > 0 ? 'up' : 'down'}>
              <span aria-hidden="true">{d.delta > 0 ? '▲' : '▼'}</span> {STAT_LABELS[d.stat](d.delta).replace('+-', '-')}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** For items that reserve spirit: what it holds now, or what equipping it would leave free. */
function SpiritPreview({ item, place }: { item: Item; place: ItemPlace | null }) {
  const classId = useUi((s) => s.classId);
  const spiritMax = useUi((s) => s.spiritMax);
  const reserved = useUi((s) => s.spiritReserved);
  if (!classId) return null;
  const cost = spiritCost(item, classId);
  if (cost === null) return null;
  const equipped = place?.at === 'sigil' || place?.at === 'warband';
  const free = spiritMax - reserved;
  if (equipped) return <p className="tt-spirit">Holds {cost} spirit while equipped</p>;
  const after = free - cost;
  return (
    <p className={`tt-spirit${after < 0 ? ' bad' : ''}`}>
      Reserves {cost} spirit · {free} free now{after < 0 ? `, needs ${-after} more` : `, ${after} after`}
    </p>
  );
}

export function ItemTooltip() {
  const { item, x, y, place } = useHover();
  const classId = useUi((s) => s.classId);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });
  // Measured after render so tall tooltips (a rare with a comparison) flip instead of clipping.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos(placeTooltip(x, y, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight));
  }, [x, y, item]);
  if (!item || !classId) return null;
  const tier: CSSProperties & Record<'--tier', string> = { '--tier': tierColor(item), left: pos.left, top: pos.top };
  return (
    <div className={`tooltip tt tt-${item.tier}`} style={tier} ref={ref} role="tooltip">
      <ItemDetails item={item} classId={classId} />
      <SpiritPreview item={item} place={place} />
      {place?.at === 'bag' && <Comparison item={item} />}
      {place?.at === 'forge' && place.warn && <p className="tt-warn">{place.warn}</p>}
      <footer className="tt-hint">
        {place?.at === 'forge'
          ? place.hint
          : place?.at === 'trader'
          ? `Click to buy for ${place.price} gold`
          : place?.at === 'bag' && useUi.getState().traderOpen
            ? isBound(item)
              ? 'Starter item: cannot be sold'
              : `Right-click to sell for ${sellPrice(item)} gold`
            : place?.at === 'stash'
          ? 'Right-click to take it out · Drag to move'
          : place?.at === 'bag'
            ? useUi.getState().stashOpen
              ? 'Right-click to stash · Drag to move or equip'
              : item.kind === 'rune'
                ? 'Inscribe it at the forge · Drag to move · Shift+right-click to drop'
                : 'Right-click to equip · Drag onto a slot · Shift+right-click to drop'
            : 'Right-click to take off · Drag to the bag'}
      </footer>
    </div>
  );
}

/**
 * One inventory or equipment cell. Every cell is a drop target; filled cells can be dragged and
 * right-clicked. Shared by the bag, the sigil and warband rows, and the paperdoll.
 */
export function ItemCell({
  item,
  place,
  selected = false,
  onSelect,
  label,
  empty,
  className = 'inv-cell',
  iconSize = 44,
  style,
  gridCell,
}: {
  item: Item | undefined;
  place: ItemPlace;
  selected?: boolean;
  onSelect?: () => void;
  label?: string | undefined;
  /** What an empty slot shows: a faint outline of what goes there. */
  empty?: ReactNode;
  className?: string;
  iconSize?: number;
  style?: CSSProperties;
  /** Pixel size of one grid cell, for bag and stash cells, so a drop knows which cell it hit. */
  gridCell?: number;
}) {
  const setHover = useHover((h) => h.set);
  const [over, setOver] = useState(false);
  const drag = useDrag((d) => d.drag);
  const level = useUi((s) => s.level);
  const classId = useUi((s) => s.classId);
  const inv = useUi((s) => s.inventory);

  const dragged = drag && inv ? itemByUid(inv, drag.uid) : undefined;
  const accepts = drag !== null && dragged !== undefined && inv !== null && classId !== null && dragged.uid !== item?.uid && dropAction(inv, dragged, drag, place, classId) !== null;
  const blocked = item && classId ? unusable(item, level, classId) : null;
  const fresh = useFresh((f) => item !== undefined && place.at === 'bag' && f.uids.has(item.uid));

  const act = (e: MouseEvent) => {
    e.preventDefault();
    const { inventory, classId: cls } = useUi.getState();
    if (!item || !inventory || !cls) return;
    setHover(null, 0, 0);
    if (e.shiftKey && place.at === 'bag') {
      const refusal = dropRefusal(item);
      if (refusal) {
        useUi.getState().notify(refusal);
        return;
      }
      // A good drop needs a second shift+right-click; junk goes straight away.
      const pending = usePendingDrop.getState();
      if ((item.tier === 'rare' || item.tier === 'relic') && (pending.uid !== item.uid || pending.sell)) {
        usePendingDrop.setState({ uid: item.uid, sell: false });
        return;
      }
      usePendingDrop.setState({ uid: null, sell: false });
      sendCommand({ t: 'discard', uid: item.uid });
      return;
    }
    const { stashOpen, traderOpen } = useUi.getState();
    // A relic asks before it goes to the shared shelf, where anyone can buy it.
    if (traderOpen && place.at === 'bag' && !isBound(item) && asksBeforeSelling(item)) {
      usePendingDrop.setState({ uid: item.uid, sell: true });
      return;
    }
    const msg = quickAction(inventory, item, place, cls, stashOpen, traderOpen);
    if (msg) sendCommand(msg);
    else if (stashOpen && (place.at === 'bag' || place.at === 'stash')) useUi.getState().notify(`No room in the ${place.at === 'bag' ? 'stash' : 'bag'}`);
    else if (item.kind === 'vessel' && cls !== 'binder') useUi.getState().notify('Only Binders can bind vessels');
    else useUi.getState().notify('All slots are full. Drag it onto the one to replace.');
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    useDrag.setState({ drag: null });
    const payload = parseDrag(e.dataTransfer.getData(DRAG_TYPE));
    const { inventory, classId: cls } = useUi.getState();
    if (!payload || !inventory || !cls) return;
    const moving = itemByUid(inventory, payload.uid);
    if (!moving) return;
    const msg = dropAction(inventory, moving, payload, cellUnder(e), cls);
    if (msg?.t === 'swapSigils') swapSkills(msg.a, msg.b);
    else if (msg) sendCommand(msg);
  };

  /** A grid place refined to the exact cell under the pointer: an item spans several cells. */
  function cellUnder(e: { clientX: number; clientY: number; currentTarget: Element }): ItemPlace {
    if (!gridCell || (place.at !== 'bag' && place.at !== 'stash') || place.x === undefined || place.y === undefined) return place;
    // Spans come from the item's footprint, not its pixel size, so window zoom and UI scale cannot
    // throw the cell count off.
    const r = e.currentTarget.getBoundingClientRect();
    const span = item ? itemSize(item) : { w: 1, h: 1 };
    const x = place.x + Math.min(span.w - 1, Math.floor(((e.clientX - r.left) / Math.max(1, r.width)) * span.w));
    const y = place.y + Math.min(span.h - 1, Math.floor(((e.clientY - r.top) / Math.max(1, r.height)) * span.h));
    return { ...place, x, y };
  }

  const tier: CSSProperties & Record<'--tier', string> = { '--tier': item ? tierColor(item) : 'transparent', ...style };
  const pips = item ? affixPips(item) : 0;
  const classes = [
    className,
    item ? `filled tier-${item.tier}` : 'empty',
    selected ? 'selected' : '',
    fresh ? 'fresh' : '',
    over ? 'drop-over' : '',
    accepts ? 'drop-ok' : '',
    blocked ? 'unusable' : '',
    drag?.uid === item?.uid && item ? 'dragging' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={classes}
      style={tier}
      draggable={item !== undefined}
      onDragStart={(e) => {
        if (!item) return;
        const under = cellUnder(e);
        const grab =
          (under.at === 'bag' || under.at === 'stash') && (place.at === 'bag' || place.at === 'stash') && under.x !== undefined && under.y !== undefined && place.x !== undefined && place.y !== undefined
            ? { x: under.x - place.x, y: under.y - place.y }
            : { x: 0, y: 0 };
        const payload: DragPayload = { uid: item.uid, from: place, grab };
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload));
        e.dataTransfer.effectAllowed = 'move';
        useDrag.setState({ drag: payload });
        setHover(null, 0, 0);
      }}
      onDragEnd={() => useDrag.setState({ drag: null })}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      onMouseEnter={(e) => {
        if (!item) return;
        setHover(item, e.clientX, e.clientY, place);
        unmarkFresh(item.uid);
      }}
      onMouseMove={(e) => item && setHover(item, e.clientX, e.clientY, place)}
      onMouseLeave={() => setHover(null, 0, 0)}
      onClick={() => item && onSelect?.()}
      onContextMenu={act}
      aria-label={item ? `${item.name}${blocked ? ' (cannot use)' : ''}` : (label ?? 'Empty slot')}
    >
      {label && <span className="inv-cell-key">{label}</span>}
      {item ? <ItemIcon item={item} size={iconSize} /> : empty}
      {pips > 0 && (
        <span className="inv-pips" aria-hidden="true">
          {Array.from({ length: pips }, (_, i) => (
            <i key={i} />
          ))}
        </span>
      )}
      {blocked?.reason === 'level' && <span className="inv-req">{blocked.need}</span>}
    </button>
  );
}

/** Paperdoll layout, D2 style: jewellery and weapon on the flanks, armour down the middle. */
const SLOT_AREA: Record<GearSlot, string> = {
  helmet: 'helmet',
  amulet: 'amulet',
  weapon: 'weapon',
  body: 'body',
  gloves: 'gloves',
  ring1: 'ring1',
  ring2: 'ring2',
  belt: 'belt',
  boots: 'boots',
};

const SLOT_NAMES: Record<GearSlot, string> = {
  weapon: 'Weapon',
  helmet: 'Helmet',
  body: 'Body armour',
  gloves: 'Gloves',
  boots: 'Boots',
  belt: 'Belt',
  amulet: 'Amulet',
  ring1: 'Ring',
  ring2: 'Ring',
};

function pct(v: number): string {
  const n = Math.round((v - 1) * 100);
  return `${n >= 0 ? '+' : ''}${n}%`;
}

function Paperdoll() {
  const inv = useUi((s) => s.inventory);
  const classId = useUi((s) => s.classId);
  const stats = useUi((s) => s.stats);
  if (!inv || !classId) return null;
  const color = `#${CLASSES[classId].color.toString(16).padStart(6, '0')}`;
  const figure: CSSProperties & Record<'--class', string> = { '--class': color };
  return (
    <div className="inv-doll" style={figure}>
      <div className="inv-doll-figure" aria-hidden="true" />
      {GEAR_SLOTS.map((slot) => (
        <ItemCell
          key={slot}
          item={itemByUid(inv, inv.gear[slot])}
          place={{ at: 'gear', slot }}
          className={`inv-cell inv-slot slot-${slot}`}
          iconSize={slot === 'body' || slot === 'weapon' ? 56 : 42}
          label={undefined}
          empty={<SlotSilhouette category={categoryForSlot(slot)} size={slot === 'body' || slot === 'weapon' ? 44 : 32} />}
          style={{ gridArea: SLOT_AREA[slot] }}
        />
      ))}
      {stats && (
        <dl className="inv-doll-stats">
          <div>
            <dt>Life</dt>
            <dd>{Math.round(stats.maxLife)}</dd>
          </div>
          <div>
            <dt>Armour</dt>
            <dd>{Math.round(stats.armor)}</dd>
          </div>
          <div>
            <dt>Damage</dt>
            <dd>{pct(stats.damageMult)}</dd>
          </div>
          <div>
            <dt>Force</dt>
            <dd>{Math.round(stats.heatMax)}</dd>
          </div>
        </dl>
      )}
      <span className="sr-only">{GEAR_SLOTS.map((s) => SLOT_NAMES[s]).join(', ')}</span>
    </div>
  );
}

/** Pixel size of one bag or stash cell. */
const CELL = 44;

/** A D2-style grid: items span their footprint, and every free cell is a drop target. */
function ItemGrid({ which, selUid, onSelect }: { which: 'bag' | 'stash'; selUid: ItemUid | null; onSelect: (uid: ItemUid) => void }) {
  const inv = useUi((s) => s.inventory);
  if (!inv) return null;
  const size: GridSize = which === 'bag' ? BAG : STASH;
  const cells = which === 'bag' ? inv.inventory : inv.stash;
  const style: CSSProperties = { gridTemplateColumns: `repeat(${size.w}, ${CELL}px)`, gridTemplateRows: `repeat(${size.h}, ${CELL}px)` };
  return (
    <div className="inv-grid" style={style}>
      {cells.map((uid, i) =>
        uid === null ? (
          <ItemCell
            key={`free-${i}`}
            item={undefined}
            place={{ at: which, x: i % size.w, y: Math.floor(i / size.w) }}
            className="inv-cell grid-free"
            style={{ gridColumn: (i % size.w) + 1, gridRow: Math.floor(i / size.w) + 1 }}
          />
        ) : null,
      )}
      {placements(cells, size).map(({ uid, x, y }) => {
        const item = itemByUid(inv, uid);
        if (!item) return null;
        const s = itemSize(item);
        return (
          <ItemCell
            key={uid}
            item={item}
            place={{ at: which, x, y }}
            gridCell={CELL}
            className="inv-cell grid-item"
            iconSize={Math.min(s.w, s.h) * CELL - 4}
            selected={uid === selUid}
            onSelect={() => onSelect(uid)}
            style={{ gridColumn: `${x + 1} / span ${s.w}`, gridRow: `${y + 1} / span ${s.h}` }}
          />
        );
      })}
    </div>
  );
}

/** The trader's shelf, shared by every player on the server: newest first, 50 at most. */
export function TraderWindow() {
  const open = useUi((s) => s.traderOpen && s.inventoryOpen);
  const stock = useUi((s) => s.traderStock);
  const gold = useUi((s) => s.inventory?.gold ?? 0);
  const setHover = useHover((h) => h.set);
  if (!open) return null;
  return (
    <section className="panel inv-window trader-window" aria-label="Trader">
      <header className="inv-header">
        <h2>Trader</h2>
        <span className="muted">
          {stock.length} / {TRADER.capacity} · shared by everyone · <span className="gold">{gold} gold</span>
        </span>
      </header>
      <div className="trader-shelf">
        {stock.length === 0 && <p className="muted">The shelf is empty. Right-click items in your bag to sell them.</p>}
        {[...stock].reverse().map((e) => (
          <button
            key={e.id}
            type="button"
            className={`trader-item tier-${e.item.tier}`}
            disabled={gold < e.price}
            onClick={() => sendCommand({ t: 'buy', id: e.id })}
            onMouseEnter={(ev) => setHover(e.item, ev.clientX, ev.clientY, { at: 'trader', price: e.price })}
            onMouseMove={(ev) => setHover(e.item, ev.clientX, ev.clientY, { at: 'trader', price: e.price })}
            onMouseLeave={() => setHover(null, 0, 0)}
            aria-label={`${e.item.name}, ${e.price} gold`}
          >
            <ItemIcon item={e.item} size={36} />
            <span className="trader-name" style={{ color: tierColor(e.item) }}>
              {e.item.name}
            </span>
            <span className="trader-price">{e.price} g</span>
          </button>
        ))}
      </div>
      <footer className="inv-footer">
        <span>
          <kbd>Right-click</kbd> a bag item to sell
        </span>
        <span>When the shelf is full, the oldest item goes for good</span>
      </footer>
    </section>
  );
}

/** The account's shared stash, beside the bag while standing at the chest in town. */
export function StashWindow() {
  // The forge sits near the chest; its editor takes the stash's place on screen while it is open.
  const open = useUi((s) => s.stashOpen && s.inventoryOpen && !s.editorOpen);
  const inv = useUi((s) => s.inventory);
  const [selUid, setSelUid] = useState<ItemUid | null>(null);
  if (!open || !inv) return null;
  const used = placements(inv.stash, STASH).length;
  return (
    <section className="panel inv-window stash-window" aria-label="Stash">
      <header className="inv-header">
        <h2>Stash</h2>
        <span className="muted">{used} items · shared by all your characters</span>
      </header>
      <div className="inv-body">
        <ItemGrid which="stash" selUid={selUid} onSelect={(uid) => setSelUid(uid === selUid ? null : uid)} />
      </div>
      <footer className="inv-footer">
        <span>
          <kbd>Right-click</kbd> move between bag and stash
        </span>
        <span>
          <kbd>Drag</kbd> to place
        </span>
      </footer>
    </section>
  );
}

/**
 * Items waiting for room: forge refunds and loot that found the bag full. They sit in no grid, so
 * without this strip they would be invisible until they move in by themselves.
 */
function PendingStrip() {
  const inv = useUi((s) => s.inventory);
  if (!inv) return null;
  const pending = pendingOf(inv);
  if (pending.length === 0) return null;
  const count = pending.reduce((n, i) => n + (i.kind === 'rune' ? i.count : 1), 0);
  return (
    <div className="inv-pending" aria-label="Pending items">
      <span className="inv-pending-head">Pending: {count}</span>
      <div className="inv-pending-items">
        {/* Not ItemCells: a pending item cannot be dragged or used, only looked at. */}
        {pending.map((item) => (
          <span
            key={item.uid}
            className={`inv-pending-cell tier-${item.tier}`}
            style={{ borderColor: tierColor(item) }}
            onMouseEnter={(e) => useHover.getState().set(item, e.clientX, e.clientY, { at: 'forge', hint: 'Pending: waits for room in your bag' })}
            onMouseMove={(e) => useHover.getState().set(item, e.clientX, e.clientY, { at: 'forge', hint: 'Pending: waits for room in your bag' })}
            onMouseLeave={() => useHover.getState().set(null, 0, 0)}
            aria-label={`${item.name}, pending`}
          >
            <ItemIcon item={item} size={28} />
            {item.kind === 'rune' && item.count > 1 && <small>{item.count}</small>}
          </span>
        ))}
      </div>
      <span className="muted small">They move into your bag as soon as there is room.</span>
    </div>
  );
}

function DropConfirm() {
  const uid = usePendingDrop((s) => s.uid);
  const sell = usePendingDrop((s) => s.sell);
  const inv = useUi((s) => s.inventory);
  const traderOpen = useUi((s) => s.traderOpen);
  const item = itemByUid(inv, uid);
  // Walking away from the trader leaves nothing to sell to.
  if (!item || (sell && !traderOpen)) return null;
  return (
    <div className="inv-confirm" role="alertdialog" aria-label={sell ? 'Sell item' : 'Drop item'}>
      <p>
        {sell ? 'Sell ' : 'Drop '}
        <strong style={{ color: tierColor(item) }}>{item.name}</strong>
        {sell ? ` for ${sellPrice(item)} gold? Anyone can buy it off the shelf.` : ' on the ground?'}
      </p>
      <div>
        <button
          type="button"
          className="danger"
          onClick={() => {
            sendCommand(sell ? { t: 'sell', uid: item.uid } : { t: 'discard', uid: item.uid });
            usePendingDrop.setState({ uid: null, sell: false });
          }}
        >
          {sell ? 'Sell it' : 'Drop it'}
        </button>
        <button type="button" onClick={() => usePendingDrop.setState({ uid: null })} autoFocus>
          Keep
        </button>
      </div>
    </div>
  );
}

export function Inventory() {
  // The forge lists the bag's runes and sigils itself and needs the width, so the bag steps aside.
  const open = useUi((s) => s.inventoryOpen && !s.editorOpen);
  const inv = useUi((s) => s.inventory);
  const classId = useUi((s) => s.classId);
  const openEditor = useUi((s) => s.openEditor);
  const editorAllowed = useUi((s) => s.forgeOpen || (s.editorAllowed && s.devTools));
  const [selUid, setSelUid] = useState<ItemUid | null>(null);
  // Beside the stash or the trader only the bag shows, like D2, so both windows fit on screen.
  const compact = useUi((s) => s.stashOpen || s.traderOpen);
  const stashOpen = useUi((s) => s.stashOpen);
  const traderOpen = useUi((s) => s.traderOpen);
  // A window that closes under the mouse never sends mouseleave, so the tooltip of the item that
  // was hovered would stay on screen. Any window opening or closing drops it.
  useEffect(() => {
    useHover.getState().set(null, 0, 0);
  }, [open, stashOpen, traderOpen]);
  // Delete drops the bag item under the mouse (rares and relics still ask first).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' || isTyping(e.target)) return;
      const { item, place } = useHover.getState();
      if (!item || place?.at !== 'bag') return;
      e.preventDefault();
      useHover.getState().set(null, 0, 0);
      requestDrop(item.uid);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open]);
  if (!open || !inv || !classId) return null;

  const selected = itemByUid(inv, selUid);
  const inBag = selUid !== null && inv.inventory.includes(selUid);
  const used = placements(inv.inventory, BAG).length;
  const close = () => {
    usePendingDrop.setState({ uid: null });
    useUi.setState({ inventoryOpen: false, characterOpen: false });
  };

  return (
    <section className={`panel inv-window${compact ? ' compact' : ''}`} aria-label="Inventory">
      <header className="inv-header">
        <h2>Inventory</h2>
        <button type="button" className="close" onClick={close} aria-label="Close inventory">
          ×
        </button>
      </header>

      <div className="inv-body">
        <div className="inv-left">
          <Paperdoll />
          <h3 className="inv-section">Skills</h3>
          <div className="inv-row">
            {inv.sigils.map((uid, slot) => (
              <ItemCell key={slot} label={String(slot + 1)} item={itemByUid(inv, uid)} place={{ at: 'sigil', slot }} selected={uid !== null && uid === selUid} onSelect={() => setSelUid(uid)} />
            ))}
          </div>
          {classId === 'binder' && (
            <>
              <h3 className="inv-section">Warband</h3>
              <div className="inv-row">
                {/* Every bound minion, then one free slot to bind another; spirit is the only limit. */}
                {inv.warband.map((uid, slot) =>
                  uid !== null || slot === inv.warband.indexOf(null) ? (
                    <ItemCell key={slot} label={String(slot + 1)} item={itemByUid(inv, uid)} place={{ at: 'warband', slot }} selected={uid !== null && uid === selUid} onSelect={() => setSelUid(uid)} />
                  ) : null,
                )}
              </div>
            </>
          )}
        </div>

        <div className="inv-right">
          <div className="inv-bag-head">
            <h3 className="inv-section">Bag</h3>
            <span className="muted">
              {used} items · <span className="gold">{inv.gold} gold</span>
            </span>
            <button type="button" className="inv-sort" onClick={() => sendCommand({ t: 'sortInventory' })} disabled={used === 0} title="Group by type, best first">
              Sort
            </button>
          </div>
          <div className="inv-bag">
            <ItemGrid which="bag" selUid={selUid} onSelect={(uid) => setSelUid(uid === selUid ? null : uid)} />
            {used === 0 && <p className="inv-empty">Your bag is empty. Walk over loot to pick it up.</p>}
          </div>
          <PendingStrip />
          <DropConfirm />
          {selected && (
            <div className="inv-selection">
              <ItemIcon item={selected} size={32} />
              <span style={{ color: tierColor(selected) }}>{selected.name}</span>
              <div className="inv-selection-actions">
                {selected.kind === 'sigil' && editorAllowed && (
                  <button type="button" onClick={() => openEditor(selected.uid)}>
                    Inscribe
                  </button>
                )}
                {inBag && dropRefusal(selected) && <span className="muted small">{dropRefusal(selected)}</span>}
                {inBag && !dropRefusal(selected) && (
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      requestDrop(selected.uid);
                      setSelUid(null);
                    }}
                  >
                    Drop
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      <footer className="inv-footer">
        <span>
          <kbd>Right-click</kbd> equip or take off
        </span>
        <span>
          <kbd>Drag</kbd> onto a slot
        </span>
        <span>
          <kbd>Del</kbd> or <kbd>Shift</kbd>+<kbd>Right-click</kbd> drop
        </span>
      </footer>
    </section>
  );
}
