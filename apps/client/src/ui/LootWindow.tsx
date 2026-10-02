import type { Item } from '@rune/shared';
import { useEffect, useState } from 'react';
import { GamePanel } from './GamePanel.js';
import { ItemIcon } from './icons.js';
import { useHover } from './Inventory.js';
import { dropLootWindow, nameColor, nameText, useLootHover, useLootWindow } from './lootPiles.js';
import { tierColor } from './parts.js';
import { sendCommand } from './store.js';
import './loot.css';

export function closeLootWindow(): void {
  if (useLootWindow.getState().id === null) return;
  dropLootWindow();
  sendCommand({ t: 'lootClose' });
  useHover.getState().set(null, 0, 0);
}

const OWN_HINT = 'Your own drop: step away before taking it back';

/** A ground pile's items: click one to take it, or Take all. Walking away closes it. */
export function LootWindow() {
  const id = useLootWindow((s) => s.id);
  const items = useLootWindow((s) => s.items);
  const own = useLootWindow((s) => s.own);
  const setHover = useHover((h) => h.set);
  // The hovered row's item can leave the pile under the cursor; its tooltip goes with it.
  useEffect(() => {
    const hovered = useHover.getState().item;
    if (hovered && useHover.getState().place?.at === 'ground' && !items?.some((i) => i.uid === hovered.uid)) setHover(null, 0, 0);
  }, [items, setHover]);
  if (id === null) return null;
  const takeable = (items ?? []).filter((i) => !own.includes(i.uid));
  const hover = (item: Item, x: number, y: number) => setHover(item, x, y, { at: 'ground', hint: own.includes(item.uid) ? OWN_HINT : 'Click to take' });
  return (
    <GamePanel id="loot" className="loot-window" aria-label="Loot" title={items ? `On the ground (${items.length})` : 'On the ground'} onClose={closeLootWindow} closeLabel="Close loot">
      <div className="loot-list" role="list">
        {items === null && <p className="muted loot-wait">Looking through the pile</p>}
        {items?.map((item) => {
          const mine = own.includes(item.uid);
          return (
            <button
              key={item.uid}
              type="button"
              role="listitem"
              className={`loot-row tier-${item.tier}`}
              aria-disabled={mine}
              onClick={() => {
                if (!mine) sendCommand({ t: 'pickup', id, uid: item.uid });
              }}
              onMouseEnter={(ev) => hover(item, ev.clientX, ev.clientY)}
              onMouseMove={(ev) => hover(item, ev.clientX, ev.clientY)}
              onMouseLeave={() => setHover(null, 0, 0)}
              aria-label={mine ? `${item.name}, your own drop` : `Take ${item.name}`}
            >
              <ItemIcon item={item} size={30} />
              <span className="loot-name" style={{ color: tierColor(item) }}>
                {item.name}
              </span>
              {item.kind === 'rune' && item.count > 1 && <span className="loot-count">x{item.count}</span>}
            </button>
          );
        })}
      </div>
      <footer className="loot-footer">
        <button type="button" disabled={takeable.length === 0} onClick={() => sendCommand({ t: 'pickup', id })}>
          Take all
        </button>
        <span className="muted small">Walk away to close</span>
      </footer>
    </GamePanel>
  );
}

/** Where the pointer last was, kept from the first move so a preview has a spot before the next one. */
const pointer = { x: -9999, y: -9999, held: false };
if (typeof window !== 'undefined') {
  const note = (e: PointerEvent) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.held = e.buttons !== 0;
  };
  window.addEventListener('pointermove', note, { passive: true });
  window.addEventListener('pointerdown', note, { passive: true });
  window.addEventListener('pointerup', note, { passive: true });
}

/**
 * The hover preview over a pile: names only, from the snapshot the client already has. It sits above
 * and right of the cursor, lets every click through, and hides while a button is held so it never
 * covers what the player is aiming at.
 */
export function LootPreview() {
  const id = useLootHover((s) => s.id);
  const names = useLootHover((s) => s.names);
  const count = useLootHover((s) => s.count);
  const [at, setAt] = useState(pointer);
  useEffect(() => {
    if (id === null) return;
    // The cursor may rest on the label it just entered, so the preview starts where it last was.
    setAt({ ...pointer });
    const move = (e: PointerEvent) => setAt({ x: e.clientX, y: e.clientY, held: e.buttons !== 0 });
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerdown', move);
    window.addEventListener('pointerup', move);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerdown', move);
      window.removeEventListener('pointerup', move);
    };
  }, [id]);
  // A single item's label already names it.
  if (id === null || at.held || count < 2) return null;
  const more = count - names.length;
  // Clear of the pile's own label under the cursor; flipped below it near the top edge, and left of it near the right edge.
  const style = { left: at.x + 18, top: at.y - 40, transform: `translate(${at.x > window.innerWidth - 260 ? 'calc(-100% - 36px)' : '0'}, ${at.y < 200 ? '28px' : '-100%'})` };
  return (
    <div className="loot-preview" style={style} role="tooltip">
      {names.map((n, i) => (
        <div key={i} style={{ color: nameColor(n) }}>
          {nameText(n)}
        </div>
      ))}
      {more > 0 && <div className="loot-more">and {more} more</div>}
    </div>
  );
}
