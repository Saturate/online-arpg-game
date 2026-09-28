import { STAT_LABELS, type Item, type ItemUid } from '@rune/shared';
import { useState, type CSSProperties, type DragEvent, type MouseEvent } from 'react';
import { create } from 'zustand';
import { ItemIcon } from './icons.js';
import { compareGear, DRAG_TYPE, dropAction, parseDrag, quickAction, replacedBy, type ItemPlace } from './itemActions.js';
import { ItemDetails, tierColor } from './parts.js';
import { itemByUid, sendCommand, useUi } from './store.js';

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

function Comparison({ item }: { item: Item }) {
  const inv = useUi((s) => s.inventory);
  if (!inv || item.kind !== 'gear') return null;
  const current = replacedBy(inv, item);
  const deltas = compareGear(item, current);
  return (
    <div className="compare">
      <h5>{current ? `Instead of ${current.name}` : 'Fills an empty slot'}</h5>
      {deltas.length === 0 ? (
        <p className="muted">No stat change</p>
      ) : (
        <ul>
          {deltas.map((d) => (
            <li key={d.stat} className={d.delta > 0 ? 'up' : 'down'}>
              {STAT_LABELS[d.stat](d.delta).replace('+-', '-')}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ItemTooltip() {
  const { item, x, y, place } = useHover();
  const classId = useUi((s) => s.classId);
  if (!item || !classId) return null;
  const left = Math.min(x + 18, window.innerWidth - 320);
  const top = Math.min(y + 18, window.innerHeight - 300);
  return (
    <div className="tooltip" style={{ left, top, borderColor: tierColor(item) }}>
      <ItemDetails item={item} classId={classId} />
      {place?.at === 'bag' && <Comparison item={item} />}
      <p className="tooltip-hint">{place?.at === 'bag' ? 'Right-click to equip. Drag onto a slot.' : 'Right-click to take off.'}</p>
    </div>
  );
}

/**
 * One inventory or equipment cell. Every cell is a drop target; filled cells can be dragged and
 * right-clicked. Shared by the bag, sigil and warband rows, and the paperdoll.
 */
export function ItemCell({
  item,
  place,
  selected = false,
  onSelect,
  label,
  className = 'cell',
  iconSize = 44,
  style,
}: {
  item: Item | undefined;
  place: ItemPlace;
  selected?: boolean;
  onSelect?: () => void;
  label?: string | undefined;
  className?: string;
  iconSize?: number;
  style?: CSSProperties;
}) {
  const setHover = useHover((h) => h.set);
  const [over, setOver] = useState(false);

  const act = (e: MouseEvent) => {
    e.preventDefault();
    const { inventory: inv, classId } = useUi.getState();
    if (!item || !inv || !classId) return;
    const msg = quickAction(inv, item, place, classId);
    if (msg) sendCommand(msg);
    else if (item.kind === 'vessel' && classId !== 'binder') useUi.getState().notify('Only Binders can bind vessels');
    else useUi.getState().notify('All slots are full. Drag it onto the one to replace.');
    setHover(null, 0, 0);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const drag = parseDrag(e.dataTransfer.getData(DRAG_TYPE));
    const { inventory: inv, classId } = useUi.getState();
    if (!drag || !inv || !classId) return;
    const dragged = itemByUid(inv, drag.uid);
    if (!dragged) return;
    const msg = dropAction(inv, dragged, drag, place, classId);
    if (msg) sendCommand(msg);
  };

  const tier: CSSProperties & Record<'--tier', string> = { '--tier': item ? tierColor(item) : 'transparent', ...style };
  return (
    <button
      type="button"
      className={`${className}${selected ? ' selected' : ''}${item ? '' : ' empty'}${over ? ' drop-over' : ''}`}
      style={tier}
      draggable={item !== undefined}
      onDragStart={(e) => {
        if (!item) return;
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ uid: item.uid, from: place }));
        e.dataTransfer.effectAllowed = 'move';
        setHover(null, 0, 0);
      }}
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
      aria-label={item ? item.name : label ?? 'Empty slot'}
    >
      {label && <span className="cell-label">{label}</span>}
      {item && <ItemIcon item={item} size={iconSize} />}
    </button>
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
  const free = inv.inventory.filter((u) => u === null).length;

  return (
    <section className="panel inventory" aria-label="Inventory">
      <header>
        <h2>Inventory</h2>
        <span className="muted">
          {inv.inventory.length - free} / {inv.inventory.length}
        </span>
        <button type="button" className="close" onClick={() => useUi.setState({ inventoryOpen: false, characterOpen: false })} aria-label="Close inventory">
          x
        </button>
      </header>

      <h3>Sigils</h3>
      <div className="row4">
        {inv.sigils.map((uid, slot) => (
          <ItemCell key={slot} label={String(slot + 1)} item={itemByUid(inv, uid)} place={{ at: 'sigil', slot }} selected={uid !== null && uid === selUid} onSelect={() => setSelUid(uid)} />
        ))}
      </div>

      {classId === 'binder' && (
        <>
          <h3>Warband</h3>
          <div className="row4">
            {inv.warband.map((uid, slot) => (
              <ItemCell key={slot} label={String(slot + 1)} item={itemByUid(inv, uid)} place={{ at: 'warband', slot }} selected={uid !== null && uid === selUid} onSelect={() => setSelUid(uid)} />
            ))}
          </div>
        </>
      )}

      <h3>Bag</h3>
      <div className="grid">
        {inv.inventory.map((uid, i) => (
          <ItemCell key={i} item={itemByUid(inv, uid)} place={{ at: 'bag' }} selected={uid !== null && uid === selUid} onSelect={() => setSelUid(uid === selUid ? null : uid)} />
        ))}
      </div>

      {selected && (
        <div className="selection">
          <ItemDetails item={selected} classId={classId} />
          <div className="actions">
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
                Drop on the ground
              </button>
            )}
          </div>
        </div>
      )}
      <p className="muted small">Right-click to equip or take off. Drag items onto slots. Click to select.</p>
    </section>
  );
}
