/**
 * What the player sees around a server restart for an update (docs/features/seamless-restart.md):
 * the admin's countdown, then a full-screen "Updating game server" overlay while the client waits
 * for the server to come back, and on the new build a reload that drops them back in.
 */

/**
 * - `waiting`: the server said it is going down (or the countdown ran out and the socket closed);
 *   the client keeps reconnecting quietly.
 * - `reloading`: the server is back on a new build and the tab is reloading onto it.
 * - `resuming`: the reloaded tab, until the game's welcome comes in.
 */
export type RestartOverlay = 'hidden' | 'waiting' | 'reloading' | 'resuming';

export interface RestartState {
  overlay: RestartOverlay;
  /** When the admin's countdown runs out (performance.now ms), or null when none is running. */
  countdownEndsAt: number | null;
  /** When the overlay last changed, for how long the client has been waiting. */
  since: number;
}

export type RestartEvent =
  /** The server's `restart` message: a countdown, or 0 for going down now. */
  | { e: 'notice'; seconds: number; now: number }
  /** The socket closed; `code` 1012 is the server saying it restarts. */
  | { e: 'closed'; code: number; now: number }
  | { e: 'welcome'; outdated: boolean; now: number }
  /** Reconnecting gave up, the player left the game, or the reloaded tab did not resume. */
  | { e: 'done'; now: number };

/** WebSocket close code for "service restart" (RFC 6455 registry), sent by the server's shutdown. */
export const SERVICE_RESTART = 1012;

/**
 * How long a restarting server is waited for. A deploy keeps it away about a minute (the image pull
 * and the Recreate strategy); three minutes covers a slow pull without leaving a dead tab spinning.
 */
export const RESTART_WAIT_MS = 3 * 60_000;

/** Between tries while waiting. Gentle on a server that is booting, quick enough to feel instant once it is up. */
export const RESTART_RETRY_MS = 2000;

/**
 * A drop this close to the end of a countdown (or after it) is the restart even without the
 * server's last word, which a proxy in between can swallow.
 */
const COUNTDOWN_SLACK_MS = 5000;

export function initialRestart(resuming: boolean, now: number): RestartState {
  return { overlay: resuming ? 'resuming' : 'hidden', countdownEndsAt: null, since: now };
}

export function nextRestart(s: RestartState, ev: RestartEvent): RestartState {
  switch (ev.e) {
    case 'notice':
      if (ev.seconds > 0) return { ...s, countdownEndsAt: ev.now + ev.seconds * 1000 };
      return s.overlay === 'waiting' ? s : { ...s, overlay: 'waiting', since: ev.now };
    case 'closed': {
      if (s.overlay === 'waiting' || s.overlay === 'reloading') return s;
      const due = s.countdownEndsAt !== null && ev.now >= s.countdownEndsAt - COUNTDOWN_SLACK_MS;
      return ev.code === SERVICE_RESTART || due ? { ...s, overlay: 'waiting', since: ev.now } : s;
    }
    case 'welcome':
      if (ev.outdated) return { ...s, overlay: 'reloading', since: ev.now };
      return { overlay: 'hidden', countdownEndsAt: null, since: ev.now };
    case 'done':
      return { overlay: 'hidden', countdownEndsAt: null, since: ev.now };
  }
}

/** Whether the client is waiting out a restart, so a failed reconnect is no reason to give up yet. */
export function waitingForServer(s: RestartState, now: number): boolean {
  return s.overlay === 'waiting' && now - s.since < RESTART_WAIT_MS;
}

/** Whole seconds left on the countdown, or null when there is none to show. */
export function countdownLeft(s: RestartState, now: number): number | null {
  if (s.countdownEndsAt === null || s.overlay !== 'hidden') return null;
  return Math.max(0, Math.ceil((s.countdownEndsAt - now) / 1000));
}

const UPDATING_KEY = 'rune.updating';

/** Set just before an update reload, so the new page keeps the overlay up until the game is back. */
export function markUpdating(): void {
  try {
    sessionStorage.setItem(UPDATING_KEY, '1');
  } catch {
    // Blocked storage: the new page simply starts without the overlay.
  }
}

/** Read once at startup. */
export function takeUpdating(): boolean {
  try {
    const v = sessionStorage.getItem(UPDATING_KEY);
    sessionStorage.removeItem(UPDATING_KEY);
    return v === '1';
  } catch {
    return false;
  }
}
