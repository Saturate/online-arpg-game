import { dayPhaseAt, type Lighting } from '@rune/shared';

/**
 * Day and night, visual only. The time of day comes from the wall clock, so every player sees the
 * same sky; the server only sends the admin's settings (day length, night brightness, a held time).
 */

/** Updated from the server's 'lighting' message; defaults until it arrives. */
export const lighting: Lighting = { dayMinutes: 20, nightBrightness: 0.6, timeOfDay: 'cycle', clockOffset: 0, heldPhase: 0.25 };

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
  return dayPhaseAt(now, lighting);
}

/** 0 in full day, 1 in deep night, easing through dusk and dawn. */
export function nightFactor(phase = dayPhase()): number {
  if (phase < DUSK) return 0;
  if (phase < NIGHT) return smooth((phase - DUSK) / (NIGHT - DUSK));
  if (phase < DAWN) return 1;
  return 1 - smooth((phase - DAWN) / (1 - DAWN));
}

/** Length of one weather step; the sky drifts between steps over the whole step. */
const WEATHER_STEP_MS = 9 * 60 * 1000;

/** A stable pseudo-random value per weather step, the same on every client for the same step. */
function stepNoise(step: number): number {
  const x = Math.sin(step * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * How overcast the sky is, 0 clear to 1 heavy cloud. From the wall clock, like the time of day, so
 * everyone sees the same sky. Mostly clear: only steps whose noise is high cloud over, and each one
 * eases in and out over minutes. `?weather=0.8` in the URL pins it, for looking at it.
 */
export function overcast(now = Date.now()): number {
  const pinned = new URLSearchParams(location.search).get('weather');
  const n = pinned === null ? NaN : Number(pinned);
  if (Number.isFinite(n)) return Math.min(1, Math.max(0, n));
  const t = now / WEATHER_STEP_MS;
  const step = Math.floor(t);
  const blend = smooth(t - step);
  const noise = stepNoise(step) * (1 - blend) + stepNoise(step + 1) * blend;
  return smooth((noise - 0.55) / 0.3);
}

/** Lamps read this each frame; the scene sets it from the night factor. */
export const lampLevel = { value: 1 };
