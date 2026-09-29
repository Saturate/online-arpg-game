/**
 * Day and night, visual only. The time of day comes from the wall clock, so every player sees the
 * same sky without the server sending anything. One day takes 20 minutes.
 */

export const DAY_SECONDS = 20 * 60;

/** Share of the day: day until DUSK, dark from NIGHT to DAWN, then light returns. */
const DUSK = 0.55;
const NIGHT = 0.65;
const DAWN = 0.9;

function smooth(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/** Where in the day we are, 0 to 1. `?time=0.7` in the URL pins it, for looking at nights. */
export function dayPhase(now = Date.now()): number {
  const pinned = new URLSearchParams(location.search).get('time');
  const n = pinned === null ? NaN : Number(pinned);
  if (Number.isFinite(n)) return ((n % 1) + 1) % 1;
  return (now / 1000 / DAY_SECONDS) % 1;
}

/** 0 in full day, 1 in deep night, easing through dusk and dawn. */
export function nightFactor(phase = dayPhase()): number {
  if (phase < DUSK) return 0;
  if (phase < NIGHT) return smooth((phase - DUSK) / (NIGHT - DUSK));
  if (phase < DAWN) return 1;
  return 1 - smooth((phase - DAWN) / (1 - DAWN));
}

/** Lamps read this each frame; the scene sets it from the night factor. */
export const lampLevel = { value: 1 };
