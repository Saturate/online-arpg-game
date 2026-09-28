import { categoryForSlot, CLASSES, GEAR_SLOTS, STAT_LABELS, type GearSlot, type Item, type ItemUid } from '@rune/shared';
import { useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import { create } from 'zustand';
import { ItemIcon, SlotSilhouette } from './icons.js';
import { compareGear, DRAG_TYPE, dropAction, parseDrag, quickAction, replacedBy, type DragPayload, type ItemPlace } from './itemActions.js';
import { affixPips, placeTooltip, unusable } from './itemView.js';
import { ItemDetails, tierColor } from './parts.js';
import { itemByUid, sendCommand, useUi } from './store.js';
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

/** A rare or relic waiting for a second click before it is dropped on the ground. */
const usePendingDrop = create<{ uid: ItemUid | null }>(() => ({ uid: null }));

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
      {place?.at === 'bag' && <Comparison item={item} />}
      <footer className="tt-hint">
        {place?.at === 'bag' ? 'Right-click to equip · Drag onto a slot · Shift+right-click to drop' : 'Right-click to take off · Drag to the bag'}
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

  const act = (e: MouseEvent) => {
    e.preventDefault();
    const { inventory, classId: cls } = useUi.getState();
    if (!item || !inventory || !cls) return;
    setHover(null, 0, 0);
    if (e.shiftKey && place.at === 'bag') {
      // A good drop needs a second shift+right-click; junk goes straight away.
      if ((item.tier === 'rare' || item.tier === 'relic') && usePendingDrop.getState().uid !== item.uid) {
        usePendingDrop.setState({ uid: item.uid });
        return;
      }
      usePendingDrop.setState({ uid: null });
      sendCommand({ t: 'discard', uid: item.uid });
      return;
    }
    const msg = quickAction(inventory, item, place, cls);
    if (msg) sendCommand(msg);
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
    const msg = dropAction(inventory, moving, payload, place, cls);
    if (msg) sendCommand(msg);
  };

  const tier: CSSProperties & Record<'--tier', string> = { '--tier': item ? tierColor(item) : 'transparent', ...style };
  const pips = item ? affixPips(item) : 0;
  const classes = [
    className,
    item ? `filled tier-${item.tier}` : 'empty',
    selected ? 'selected' : '',
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
        const payload: DragPayload = { uid: item.uid, from: place };
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
      onMouseEnter={(e) => item && setHover(item, e.clientX, e.clientY, place)}
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

function DropConfirm() {
  const uid = usePendingDrop((s) => s.uid);
  const inv = useUi((s) => s.inventory);
  const item = itemByUid(inv, uid);
  if (!item) return null;
  return (
    <div className="inv-confirm" role="alertdialog" aria-label="Drop item">
      <p>
        Drop <strong style={{ color: tierColor(item) }}>{item.name}</strong> on the ground?
      </p>
      <div>
        <button
          type="button"
          className="danger"
          onClick={() => {
            sendCommand({ t: 'discard', uid: item.uid });
            usePendingDrop.setState({ uid: null });
          }}
        >
          Drop it
        </button>
        <button type="button" onClick={() => usePendingDrop.setState({ uid: null })} autoFocus>
          Keep
        </button>
      </div>
    </div>
  );
}

export function Inventory() {
  const open = useUi((s) => s.inventoryOpen);
  const inv = useUi((s) => s.inventory);
  const classId = useUi((s) => s.classId);
  const openEditor = useUi((s) => s.openEditor);
  const editorAllowed = useUi((s) => s.editorAllowed);
  const [selUid, setSelUid] = useState<ItemUid | null>(null);
  if (!open || !inv || !classId) return null;

  const selected = itemByUid(inv, selUid);
  const inBag = selUid !== null && inv.inventory.includes(selUid);
  const used = inv.inventory.filter((u) => u !== null).length;
  const close = () => {
    usePendingDrop.setState({ uid: null });
    useUi.setState({ inventoryOpen: false, characterOpen: false });
  };

  return (
    <section className="panel inv-window" aria-label="Inventory">
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
                {inv.warband.map((uid, slot) => (
                  <ItemCell key={slot} label={String(slot + 1)} item={itemByUid(inv, uid)} place={{ at: 'warband', slot }} selected={uid !== null && uid === selUid} onSelect={() => setSelUid(uid)} />
                ))}
              </div>
            </>
          )}
        </div>

        <div className="inv-right">
          <div className="inv-bag-head">
            <h3 className="inv-section">Bag</h3>
            <span className="muted">
              {used} / {inv.inventory.length}
            </span>
            <button type="button" className="inv-sort" onClick={() => sendCommand({ t: 'sortInventory' })} disabled={used === 0} title="Group by type, best first">
              Sort
            </button>
          </div>
          <div className="inv-bag">
            {inv.inventory.map((uid, i) => (
              <ItemCell key={i} item={itemByUid(inv, uid)} place={{ at: 'bag' }} selected={uid !== null && uid === selUid} onSelect={() => setSelUid(uid === selUid ? null : uid)} />
            ))}
            {used === 0 && <p className="inv-empty">Your bag is empty. Walk over loot to pick it up.</p>}
          </div>
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
                {inBag && (
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      sendCommand({ t: 'discard', uid: selected.uid });
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
          <kbd>Shift</kbd>+<kbd>Right-click</kbd> drop
        </span>
      </footer>
    </section>
  );
}
