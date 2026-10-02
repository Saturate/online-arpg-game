import { useEffect, useState } from 'react';
import { countdownLeft, type RestartOverlay as Phase } from '../game/restart.js';
import { useUi } from './store.js';

/** A reloaded tab that never got back into the game (the character is gone, the server refused) stops waiting. */
const RESUME_TIMEOUT_MS = 20_000;

const STEP: Record<Exclude<Phase, 'hidden'>, string> = {
  waiting: 'Waiting for the server to come back',
  reloading: 'Loading the new version',
  resuming: 'Taking you back in',
};

/** Full screen while the server restarts for an update; the game behind it is gone until it is back. */
export function RestartOverlay() {
  const phase = useUi((s) => s.restart.overlay);

  useEffect(() => {
    if (phase !== 'resuming') return;
    const t = setTimeout(() => useUi.getState().restartEvent({ e: 'done', now: performance.now() }), RESUME_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [phase]);

  if (phase === 'hidden') return null;
  return (
    <div className="restart-overlay" role="status" aria-live="polite">
      <div className="restart-card">
        <div className="restart-sigil" aria-hidden="true" />
        <h1>Updating game server</h1>
        <p>Please hang tight. You will be back where you stood.</p>
        <p className="restart-step">{STEP[phase]}</p>
      </div>
    </div>
  );
}

/** The admin's countdown before a restart, small and out of the way of the fight. */
export function RestartCountdown() {
  const restart = useUi((s) => s.restart);
  const [now, setNow] = useState(() => performance.now());
  const active = restart.countdownEndsAt !== null && restart.overlay === 'hidden';

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(t);
  }, [active]);

  const left = countdownLeft(restart, now);
  // The server forgets a countdown a minute after it ran out (no deploy followed); so does the pill.
  if (left === null || restart.countdownEndsAt === null || now > restart.countdownEndsAt + 60_000) return null;
  const text = left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'any moment';
  return (
    <div className="restart-countdown" role="timer" aria-live="off">
      Server update in <b>{text}</b>
    </div>
  );
}
