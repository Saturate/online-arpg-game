import { isZoneId, ZONES } from '@rune/shared';
import { sendCommand, useUi } from './store.js';
import { useMovablePanel } from './GamePanel.js';

/** A gate's name from its id (`steppe-gate` is the Ashen Steppe Gate), as the map names it. */
function gateName(id: string | null): string {
  const region = id?.replace(/-gate$/, '');
  return region !== undefined && isZoneId(region) ? `${ZONES[region].name} Gate` : 'gate';
}

/** D2-style waypoint list: every waypoint of the world in order; found ones can be travelled to, the rest show as locked. */
export function WaypointPanel() {
  const menu = useUi((s) => s.waypointMenu);
  const gates = useUi((s) => s.gates);
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
          const found = menu.unlocked.includes(wp.id);
          // Behind a gate this character has not opened: found or not, the way there is its boss.
          const sealed = wp.behind !== null && !gates.includes(wp.behind);
          const unlocked = found && !sealed;
          const here = wp.id === menu.current;
          return (
            <li key={wp.id}>
              <button
                type="button"
                disabled={!unlocked || here}
                className={here ? 'here' : unlocked ? '' : sealed ? 'locked sealed' : 'locked'}
                title={sealed ? `Past the ${gateName(wp.behind)}: slay its guardian to open it` : undefined}
                onClick={() => {
                  sendCommand({ t: 'useWaypoint', waypoint: wp.id });
                  close();
                }}
              >
                <span>{found ? wp.name : 'Undiscovered'}</span>
                <span className="muted">{here ? 'You are here' : sealed ? 'Sealed' : `Monster level ${wp.level}`}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="muted small">Touch a waypoint once to activate it. Walk away to close.</p>
    </section>
  );
}
