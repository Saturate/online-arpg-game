import { forwardRef } from 'react';
import { create } from 'zustand';
import { keyLabel, useSettings } from './settings.js';
import { useUi } from './store.js';
import './worldmap.css';

/** Whether the world map is open. Its own store, since only the map key, Escape and this view touch it. */
export const useWorldMap = create<{ open: boolean }>(() => ({ open: false }));

export function toggleWorldMap(): void {
  useWorldMap.setState((s) => ({ open: !s.open }));
}

/**
 * The world map: the explored world over the game, turned like the corner minimap. It lets the mouse
 * through and does not pause anything, so walking on with it open works, as with D2's overlay map.
 * The canvas always exists (the game draws into it), so closing only hides it.
 */
export const WorldMapView = forwardRef<HTMLCanvasElement>(function WorldMapView(_props, ref) {
  const open = useWorldMap((s) => s.open);
  const place = useUi((s) => s.roomName);
  const key = useSettings((s) => s.bindings.worldMap);
  return (
    <div className={`worldmap${open ? '' : ' hidden'}`} aria-hidden={!open}>
      <header>
        <h2>{place}</h2>
        <span className="muted small">
          <kbd>{keyLabel(key)}</kbd> or <kbd>Esc</kbd> to close
        </span>
      </header>
      <canvas ref={ref} aria-label="World map" />
      <ul className="worldmap-legend">
        <li>
          <i className="you" />
          You
        </li>
        <li>
          <i className="ally" />
          Party
        </li>
        <li>
          <i className="wp found" />
          Waypoint
        </li>
        <li>
          <i className="wp" />
          Not yet touched
        </li>
        <li>
          <i className="dungeon" />
          Dungeon
        </li>
        <li>
          <i className="gate" />
          Gate
        </li>
      </ul>
    </div>
  );
});
