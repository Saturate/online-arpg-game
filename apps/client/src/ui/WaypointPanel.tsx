import { ZONE_IDS, ZONES } from '@rune/shared';
import { sendCommand, useUi } from './store.js';

/** D2-style waypoint list. Found waypoints can be travelled to; the rest show as locked. */
export function WaypointPanel() {
  const menu = useUi((s) => s.waypointMenu);
  if (!menu) return null;
  const close = () => useUi.setState({ waypointMenu: null });
  return (
    <section className="panel waypoints" aria-label="Waypoints">
      <header>
        <h2>Waypoints</h2>
        <button type="button" className="close" onClick={close} aria-label="Close waypoints">
          x
        </button>
      </header>
      <ul>
        {ZONE_IDS.map((id) => {
          const zone = ZONES[id];
          const unlocked = menu.unlocked.includes(id);
          const here = id === menu.current;
          return (
            <li key={id}>
              <button
                type="button"
                disabled={!unlocked || here}
                className={here ? 'here' : unlocked ? '' : 'locked'}
                onClick={() => {
                  sendCommand({ t: 'useWaypoint', zone: id });
                  close();
                }}
              >
                <span>{unlocked ? zone.name : 'Undiscovered'}</span>
                <span className="muted">{here ? 'You are here' : `Level ${zone.levels[0]} to ${zone.levels[1]}`}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="muted small">Touch a waypoint once to activate it. Walk away to close.</p>
    </section>
  );
}
