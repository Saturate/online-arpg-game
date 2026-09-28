import type { Item, ItemUid } from '@rune/shared';
import { ItemIcon } from './icons.js';
import { useState } from 'react';
import { create } from 'zustand';
import { ItemDetails, tierColor } from './parts.js';
import { itemByUid, sendCommand, useUi } from './store.js';

interface HoverState {
  item: Item | null;
  x: number;
  y: number;
  set: (item: Item | null, x: number, y: number) => void;
}

/** Hovered item for the floating tooltip; kept out of the main store because it changes on every mouse move. */
export const useHover = create<HoverState>((set) => ({ item: null, x: 0, y: 0, set: (item, x, y) => set({ item, x, y }) }));

export function ItemTooltip() {
  const { item, x, y } = useHover();
  const classId = useUi((s) => s.classId);
  if (!item || !classId) return null;
  const left = Math.min(x + 18, window.innerWidth - 300);
  const top = Math.min(y + 18, window.innerHeight - 240);
  return (
    <div className="tooltip" style={{ left, top }}>
      <ItemDetails item={item} classId={classId} />
    </div>
  );
}

type Selection = { uid: ItemUid; where: 'inventory' } | { uid: ItemUid; where: 'sigil'; slot: number } | { uid: ItemUid; where: 'warband'; slot: number };

function Cell({ item, selected, onClick, label }: { item: Item | undefined; selected: boolean; onClick: () => void; label?: string }) {
  const setHover = useHover((h) => h.set);
  return (
    <button
      onMouseEnter={(e) => item && setHover(item, e.clientX, e.clientY)}
      onMouseMove={(e) => item && setHover(item, e.clientX, e.clientY)}
      onMouseLeave={() => setHover(null, 0, 0)}
      type="button"
      className={`cell${selected ? ' selected' : ''}${item ? '' : ' empty'}`}
      style={item ? { borderColor: tierColor(item) } : undefined}
      onClick={onClick}
      disabled={!item}
      title={item?.name}
    >
      {label && <span className="cell-label">{label}</span>}
      {item && <ItemIcon item={item} />}
    </button>
  );
}

export function Inventory() {
  const open = useUi((s) => s.inventoryOpen);
  const inv = useUi((s) => s.inventory);
  const classId = useUi((s) => s.classId);
  const openEditor = useUi((s) => s.openEditor);
  const editorAllowed = useUi((s) => s.editorAllowed);
  const [sel, setSel] = useState<Selection | null>(null);
  if (!open || !inv || !classId) return null;

  const selected = sel ? itemByUid(inv, sel.uid) : undefined;
  const free = inv.inventory.filter((u) => u === null).length;

  return (
    <section className="panel inventory" aria-label="Inventory">
      <header>
        <h2>Inventory</h2>
        <span className="muted">{20 - free} / 20</span>
        <button type="button" className="close" onClick={() => useUi.setState({ inventoryOpen: false })} aria-label="Close inventory">
          x
        </button>
      </header>

      <h3>Sigils</h3>
      <div className="row4">
        {inv.sigils.map((uid, slot) => (
          <Cell
            key={slot}
            label={String(slot + 1)}
            item={itemByUid(inv, uid)}
            selected={sel?.where === 'sigil' && sel.slot === slot}
            onClick={() => uid !== null && setSel({ uid, where: 'sigil', slot })}
          />
        ))}
      </div>

      {classId === 'binder' && (
        <>
          <h3>Warband</h3>
          <div className="row4">
            {inv.warband.map((uid, slot) => (
              <Cell
                key={slot}
                label={String(slot + 1)}
                item={itemByUid(inv, uid)}
                selected={sel?.where === 'warband' && sel.slot === slot}
                onClick={() => uid !== null && setSel({ uid, where: 'warband', slot })}
              />
            ))}
          </div>
        </>
      )}

      <h3>Bag</h3>
      <div className="grid">
        {inv.inventory.map((uid, i) => (
          <Cell
            key={i}
            item={itemByUid(inv, uid)}
            selected={sel?.where === 'inventory' && sel.uid === uid}
            onClick={() => uid !== null && setSel({ uid, where: 'inventory' })}
          />
        ))}
      </div>

      {selected && sel && (
        <div className="selection">
          <ItemDetails item={selected} classId={classId} />
          <div className="actions">
            {selected.kind === 'sigil' && sel.where === 'inventory' &&
              [0, 1, 2, 3].map((slot) => (
                <button
                  key={slot}
                  type="button"
                  onClick={() => {
                    sendCommand({ t: 'equipSigil', uid: selected.uid, slot });
                    setSel(null);
                  }}
                >
                  Equip {slot + 1}
                </button>
              ))}
            {selected.kind === 'gear' && sel.where === 'inventory' && (
              <button
                type="button"
                onClick={() => {
                  sendCommand({ t: 'equipGear', uid: selected.uid });
                  setSel(null);
                }}
              >
                Equip
              </button>
            )}
            {selected.kind === 'vessel' && sel.where === 'inventory' && classId === 'binder' &&
              [0, 1, 2, 3].map((slot) => (
                <button
                  key={slot}
                  type="button"
                  onClick={() => {
                    sendCommand({ t: 'equipVessel', uid: selected.uid, slot });
                    setSel(null);
                  }}
                >
                  Bind {slot + 1}
                </button>
              ))}
            {sel.where === 'sigil' && (
              <button
                type="button"
                onClick={() => {
                  sendCommand({ t: 'unequipSigil', slot: sel.slot });
                  setSel(null);
                }}
              >
                Unequip
              </button>
            )}
            {sel.where === 'warband' && (
              <button
                type="button"
                onClick={() => {
                  sendCommand({ t: 'unequipVessel', slot: sel.slot });
                  setSel(null);
                }}
              >
                Unbind
              </button>
            )}
            {selected.kind === 'sigil' && editorAllowed && (
              <button type="button" onClick={() => openEditor(selected.uid)}>
                Inscribe
              </button>
            )}
            {sel.where === 'inventory' && (
              <button
                type="button"
                className="danger"
                onClick={() => {
                  sendCommand({ t: 'discard', uid: selected.uid });
                  setSel(null);
                }}
              >
                Drop
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
