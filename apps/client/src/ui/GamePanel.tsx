import { useCallback, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { create } from 'zustand';
import { clampToViewport, parsePanelStore, snapPanel, type PanelStore, type Point, type Rect } from './panelLayout.js';
import { useSettings } from './settings.js';

/**
 * Movable panels. Every panel keeps its CSS spot until the player unlocks panels and drags one by
 * its title bar; from then on its saved screen position wins. Positions are per browser, like the
 * other settings, because they depend on the screen.
 */

const STORAGE_KEY = 'rune.panels';

interface PanelLayoutState {
  unlocked: boolean;
  positions: Record<string, Point>;
  setUnlocked: (on: boolean) => void;
  place: (id: string, p: Point) => void;
  resetPositions: () => void;
}

function load(): PanelStore {
  try {
    return parsePanelStore(localStorage.getItem(STORAGE_KEY));
  } catch {
    return parsePanelStore(null);
  }
}

function save(s: PanelStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ unlocked: s.unlocked, positions: s.positions }));
  } catch {
    // Blocked storage: positions last for this session only.
  }
}

export const usePanelLayout = create<PanelLayoutState>((set, get) => ({
  ...load(),
  setUnlocked: (on) => {
    set({ unlocked: on });
    save(get());
  },
  place: (id, p) => {
    set({ positions: { ...get().positions, [id]: p } });
    save(get());
  },
  resetPositions: () => {
    set({ positions: {} });
    save(get());
  },
}));

/** Screen pixels per CSS pixel for this element: the UI scale times any zoom of its own. */
function zoomOf(el: HTMLElement): number {
  const w = el.offsetWidth;
  if (w <= 0) return 1;
  const z = el.getBoundingClientRect().width / w;
  return Number.isFinite(z) && z > 0 ? z : 1;
}

function viewport(): { w: number; h: number } {
  return { w: window.innerWidth, h: window.innerHeight };
}

/** Writes a screen position as inline styles, overriding whatever anchored the panel in CSS. */
function applyPosition(el: HTMLElement, p: Point | null): void {
  if (p === null) {
    for (const k of ['position', 'left', 'top', 'right', 'bottom', 'transform', 'margin']) el.style.removeProperty(k);
    return;
  }
  const rect = el.getBoundingClientRect();
  const at = clampToViewport(p, { w: rect.width, h: rect.height }, viewport());
  const z = zoomOf(el);
  el.style.position = 'absolute';
  el.style.left = `${at.x / z}px`;
  el.style.top = `${at.y / z}px`;
  el.style.right = 'auto';
  el.style.bottom = 'auto';
  el.style.transform = 'none';
  el.style.margin = '0';
}

/**
 * Open panels other than this one, in screen pixels, for edge snapping. Plain .panel windows that
 * are not movable yet still count, so a moved panel can sit against the inventory.
 */
function otherPanels(self: HTMLElement): Rect[] {
  const out: Rect[] = [];
  for (const n of document.querySelectorAll<HTMLElement>('[data-panel], .panel:not(.skill-pop):not(.spirit-pop)')) {
    if (n === self || self.contains(n) || n.contains(self)) continue;
    const r = n.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push({ x: r.left, y: r.top, w: r.width, h: r.height });
  }
  return out;
}

const INTERACTIVE = 'button, input, select, textarea, a, [role="button"], [draggable="true"]';

export interface MovablePanel {
  /** Goes on the panel's root element. */
  ref: (el: HTMLElement | null) => void;
  /** Spread onto the title bar: it becomes the drag handle while panels are unlocked. */
  handleProps: {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    'data-drag-handle'?: true;
  };
  unlocked: boolean;
}

/**
 * Makes any panel movable by its title bar. `id` names the saved position, so keep it stable.
 * The panel's CSS decides where it sits until it has been dragged once.
 */
export function useMovablePanel(id: string): MovablePanel {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const saved = usePanelLayout((s) => s.positions[id] ?? null);
  const unlocked = usePanelLayout((s) => s.unlocked);
  const uiScale = useSettings((s) => s.options.uiScale);
  const dragging = useRef(false);

  const ref = useCallback(
    (node: HTMLElement | null) => {
      if (node) node.dataset.panel = id;
      setEl(node);
    },
    [id],
  );

  useLayoutEffect(() => {
    if (el && !dragging.current) applyPosition(el, saved);
  }, [el, saved, uiScale]);

  // Re-clamp when the window shrinks or the panel grows (a longer list, a bigger UI scale).
  useEffect(() => {
    if (!el || !saved) return;
    const again = () => {
      if (!dragging.current) applyPosition(el, saved);
    };
    window.addEventListener('resize', again);
    const ro = new ResizeObserver(again);
    ro.observe(el);
    return () => {
      window.removeEventListener('resize', again);
      ro.disconnect();
    };
  }, [el, saved]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!el || !usePanelLayout.getState().unlocked || e.button !== 0) return;
      if (e.target instanceof Element && e.target.closest(INTERACTIVE)) return;
      e.preventDefault();
      const start = el.getBoundingClientRect();
      const others = otherPanels(el);
      const ox = e.clientX;
      const oy = e.clientY;
      let last: Point = { x: start.left, y: start.top };
      dragging.current = true;
      el.classList.add('dragging-panel');
      const move = (ev: PointerEvent) => {
        const rect = { x: start.left + ev.clientX - ox, y: start.top + ev.clientY - oy, w: start.width, h: start.height };
        last = snapPanel(rect, others, viewport());
        applyPosition(el, last);
      };
      const up = () => {
        dragging.current = false;
        el.classList.remove('dragging-panel');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        usePanelLayout.getState().place(id, last);
      };
      // On the window, so a fast flick that outruns the title bar still drags.
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    [el, id],
  );

  return { ref, handleProps: unlocked ? { onPointerDown, 'data-drag-handle': true } : { onPointerDown }, unlocked };
}

interface GamePanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Names the saved position; keep it stable across releases. */
  id: string;
  title: ReactNode;
  /** Extra title bar content between the title and the close button. */
  headerExtra?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  headerClassName?: string;
  children?: ReactNode;
}

/** The framed window every panel shares: a title bar that drags when unlocked, and a close button. */
export function GamePanel({ id, title, headerExtra, onClose, closeLabel, headerClassName, className, children, ...rest }: GamePanelProps) {
  const { ref, handleProps } = useMovablePanel(id);
  return (
    <section {...rest} ref={ref} className={`panel${className ? ` ${className}` : ''}`}>
      <header className={headerClassName} {...handleProps}>
        <h2>{title}</h2>
        {headerExtra}
        {onClose && (
          <button type="button" className="close" onClick={onClose} aria-label={closeLabel ?? 'Close'}>
            ×
          </button>
        )}
      </header>
      {children}
    </section>
  );
}
