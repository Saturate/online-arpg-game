import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type MouseEvent, type ReactNode } from 'react';
import { create } from 'zustand';
import { placeTooltip } from './itemView.js';

/**
 * The game's own tooltip for chips, buttons and icons, in place of the browser's title bubble:
 * placed and framed like the item tooltips, and shown on keyboard focus too.
 */

interface TipState {
  content: ReactNode;
  /** The element that owns the tip, so it can be dropped when that element goes away. */
  owner: Element | null;
  x: number;
  y: number;
}

const useTip = create<TipState>(() => ({ content: null, owner: null, x: 0, y: 0 }));

export function hideTip(): void {
  useTip.setState({ content: null, owner: null });
}

export interface TipHandlers {
  onMouseEnter: (e: MouseEvent<HTMLElement>) => void;
  onMouseMove: (e: MouseEvent<HTMLElement>) => void;
  onMouseLeave: () => void;
  onFocus: (e: FocusEvent<HTMLElement>) => void;
  onBlur: () => void;
}

/** Spread onto any element: `<button {...tip('Inventory (I)')}>`. Empty content shows nothing. */
export function tip(content: ReactNode): TipHandlers {
  const show = (owner: Element, x: number, y: number) => {
    if (content === null || content === undefined || content === '' || content === false) return;
    useTip.setState({ content, owner, x, y });
  };
  return {
    onMouseEnter: (e) => show(e.currentTarget, e.clientX, e.clientY),
    onMouseMove: (e) => show(e.currentTarget, e.clientX, e.clientY),
    onMouseLeave: hideTip,
    // Keyboard focus has no pointer, so the tip hangs off the element's lower left corner.
    onFocus: (e) => {
      if (!e.currentTarget.matches(':focus-visible')) return;
      const r = e.currentTarget.getBoundingClientRect();
      show(e.currentTarget, r.left, r.bottom);
    },
    onBlur: hideTip,
  };
}

/** Rendered once, outside the scaled UI layer, since it is placed in screen coordinates. */
export function GameTooltip() {
  const { content, owner, x, y } = useTip();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos(placeTooltip(x, y, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight));
  }, [x, y, content]);

  // A panel that closes under the mouse never sends mouseleave; a click usually means the tip is
  // stale too (the button changed what it does).
  useEffect(() => {
    if (!owner) return;
    const timer = setInterval(() => {
      if (!owner.isConnected) hideTip();
    }, 200);
    window.addEventListener('pointerdown', hideTip, { capture: true });
    return () => {
      clearInterval(timer);
      window.removeEventListener('pointerdown', hideTip, { capture: true });
    };
  }, [owner]);

  if (content === null) return null;
  return (
    <div className="tooltip game-tip" ref={ref} role="tooltip" style={{ left: pos.left, top: pos.top }}>
      {content}
    </div>
  );
}
