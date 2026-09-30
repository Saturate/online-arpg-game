import { useSettings } from './settings.js';

/**
 * Quiet interface sounds made on the fly with WebAudio, so there is no asset to license: a dull
 * iron clack for a click and a faint tick for hovering something clickable.
 */

/** What counts as clickable for the sounds; the game world (the canvas) never makes UI sounds. */
const CLICKABLE = [
  'button:not(:disabled)',
  '[role="button"]',
  '[role="radio"]',
  'a[href]',
  'select',
  'input[type="checkbox"]',
  'input[type="range"]',
  '.rune-chip',
  '.inv-cell.filled',
  '[draggable="true"]',
].join(', ');

/** Deterministic noise, so every click sounds the same. */
function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 0xffffffff) * 2 - 1;
  };
}

/**
 * A struck plate: a band of noise that dies in a few milliseconds over a low knock, then a smaller
 * second strike, like a latch settling. Peak level is kept low; the volume slider scales it again.
 */
export function synthClick(rate: number): Float32Array {
  const out = new Float32Array(Math.round(rate * 0.07));
  const rnd = noise(7);
  let lp = 0;
  let prev = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    // One-pole low pass then a difference: a rough band around 1.5 to 3 kHz.
    lp += 0.35 * (rnd() - lp);
    const band = lp - prev;
    prev = lp;
    const strike = Math.exp(-t / 0.006) + (t > 0.018 ? 0.35 * Math.exp(-(t - 0.018) / 0.004) : 0);
    const knock = Math.sin(2 * Math.PI * 170 * t) * Math.exp(-t / 0.018);
    out[i] = 0.55 * band * strike + 0.3 * knock;
  }
  return out;
}

/** A faint dry tick: high noise gone within about 10 ms. */
export function synthHover(rate: number): Float32Array {
  const out = new Float32Array(Math.round(rate * 0.025));
  const rnd = noise(11);
  let prev = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const n = rnd();
    out[i] = 0.12 * (n - prev) * Math.exp(-t / 0.0025);
    prev = n;
  }
  return out;
}

let ctx: AudioContext | null = null;
let clickBuf: AudioBuffer | null = null;
let hoverBuf: AudioBuffer | null = null;

function buffer(c: AudioContext, data: Float32Array): AudioBuffer {
  const b = c.createBuffer(1, data.length, c.sampleRate);
  b.copyToChannel(new Float32Array(data), 0);
  return b;
}

/** Browsers only allow audio after a gesture, so the context is made on the first press. */
function ensureContext(): AudioContext | null {
  if (ctx) return ctx;
  try {
    ctx = new AudioContext();
    clickBuf = buffer(ctx, synthClick(ctx.sampleRate));
    hoverBuf = buffer(ctx, synthHover(ctx.sampleRate));
  } catch {
    ctx = null;
  }
  return ctx;
}

function play(which: 'click' | 'hover'): void {
  const volume = useSettings.getState().options.uiVolume;
  if (volume <= 0 || !ctx || document.hidden) return;
  const buf = which === 'click' ? clickBuf : hoverBuf;
  if (!buf) return;
  if (ctx.state === 'suspended') void ctx.resume();
  const src = ctx.createBufferSource();
  src.buffer = buf;
  // A slight random pitch keeps a run of clicks from sounding like a machine gun.
  src.playbackRate.value = 0.94 + Math.random() * 0.12;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  src.connect(gain).connect(ctx.destination);
  src.start();
}

function clickableFrom(t: EventTarget | null): Element | null {
  if (!(t instanceof Element)) return null;
  if (t instanceof HTMLCanvasElement) return null;
  return t.closest(CLICKABLE);
}

let lastHovered: Element | null = null;
let lastHoverAt = 0;

/** Listens on the whole document once; call from the game's entry point only, never the admin. */
export function installUiSounds(): void {
  document.addEventListener(
    'pointerdown',
    (e) => {
      ensureContext();
      if (e.button !== 0 && e.button !== 2) return;
      if (clickableFrom(e.target)) play('click');
    },
    { capture: true },
  );
  document.addEventListener('pointerover', (e) => {
    const el = clickableFrom(e.target);
    if (el === lastHovered) return;
    lastHovered = el;
    // Sweeping across a row of buttons should rustle, not rattle.
    const now = performance.now();
    if (el && now - lastHoverAt > 45) {
      lastHoverAt = now;
      play('hover');
    }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && clickableFrom(e.target) && e.target instanceof HTMLButtonElement) {
      ensureContext();
      play('click');
    }
  });
}
