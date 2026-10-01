import { sendCommand, useUi } from './store.js';
import { useMovablePanel } from './GamePanel.js';

/** D2-style waypoint list: every waypoint of the world in order; found ones can be travelled to, the rest show as locked. */
export function WaypointPanel() {
  const menu = useUi((s) => s.waypointMenu);
  const { ref: panelRef, handleProps } = useMovablePanel('waypoints');
  if (!menu) return null;
  const close = () => useUi.setState({ waypointMenu: null });
  return (
    <section ref={panelRef} className="panel waypoints" aria-label="Waypoints">
      <header {...handleProps}>
        <h2>Waypoints</h2>
        <button type="button" className="close" onClick={close} aria-label="Close waypoints">
          ×
        </button>
      </header>
      <ul>
        {menu.list.map((wp) => {
          const unlocked = menu.unlocked.includes(wp.id);
          const here = wp.id === menu.current;
          return (
            <li key={wp.id}>
              <button
                type="button"
                disabled={!unlocked || here}
                className={here ? 'here' : unlocked ? '' : 'locked'}
                onClick={() => {
                  sendCommand({ t: 'useWaypoint', waypoint: wp.id });
                  close();
                }}
              >
                <span>{unlocked ? wp.name : 'Undiscovered'}</span>
                <span className="muted">{here ? 'You are here' : `Monster level ${wp.level}`}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="muted small">Touch a waypoint once to activate it. Walk away to close.</p>
    </section>
  );
}
