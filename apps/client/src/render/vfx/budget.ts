import type { QualityLevel } from './quality.js';

/**
 * Decides how many of the particles an emitter asks for actually spawn this frame, so a crowded
 * fight thins its effects instead of dropping frames. Three things scale requests down:
 *
 * - the quality level's spawn scale,
 * - how full the pools are: ambient requests (burning ground, status flames, trails) fade out from
 *   half full, so impacts and deaths still have room when everything is on fire,
 * - frame time: when a smoothed frame time goes over the level's budget, ambient spawning backs off
 *   further, and recovers slowly once frames are fast again.
 *
 * Important requests (hits, deaths, explosions) only take the quality scale and the per-frame cap,
 * because missing one of those reads as a bug.
 */
export class ParticleBudget {
  private level: QualityLevel;
  private spawnedThisFrame = 0;
  private fullness = 0;
  /** Smoothed frame time in milliseconds. */
  private frameMs = 0;
  /** 1 while frames are fast, down to MIN_FRAME_SCALE when they are slow. */
  private frameScale = 1;

  constructor(
    level: QualityLevel,
    private readonly random: () => number = Math.random,
  ) {
    this.level = level;
  }

  setLevel(level: QualityLevel): void {
    this.level = level;
  }

  /** Call once per frame before any spawning. `fullness` is live particles over capacity, 0 to 1. */
  beginFrame(dtSeconds: number, fullness: number): void {
    this.spawnedThisFrame = 0;
    this.fullness = Math.min(1, Math.max(0, fullness));
    const ms = dtSeconds * 1000;
    // A hitch (tab switch, shader compile) is not a crowded fight; it must not throttle for seconds.
    if (ms > 0 && ms < 100) this.frameMs = this.frameMs === 0 ? ms : this.frameMs + (ms - this.frameMs) * 0.1;
    const over = this.frameMs - this.level.frameBudgetMs;
    if (over > 0) this.frameScale = Math.max(MIN_FRAME_SCALE, this.frameScale - dtSeconds * over * 0.15);
    else this.frameScale = Math.min(1, this.frameScale + dtSeconds * 0.25);
  }

  /** The share of an ambient request that would spawn now, before rounding. */
  get ambientScale(): number {
    const crowd = this.fullness < 0.5 ? 1 : Math.max(0, 1 - (this.fullness - 0.5) / 0.45);
    return this.level.spawnScale * crowd * this.frameScale;
  }

  get importantScale(): number {
    return this.level.spawnScale;
  }

  /**
   * How many of `wanted` particles to spawn. Fractions round up or down at random, so a trickle of
   * 0.3 per frame still spawns about one particle every three frames.
   */
  take(wanted: number, important = false): number {
    const scaled = wanted * (important ? this.importantScale : this.ambientScale);
    let n = Math.floor(scaled);
    if (this.random() < scaled - n) n++;
    const room = this.level.maxSpawnPerFrame - this.spawnedThisFrame;
    n = Math.max(0, Math.min(n, room));
    this.spawnedThisFrame += n;
    return n;
  }

  /** Whether an optional extra (a flash sprite, an arc) should run this frame at this ambient rate. */
  chance(perFrame: number): boolean {
    return this.random() < perFrame * this.ambientScale;
  }

  get smoothedFrameMs(): number {
    return this.frameMs;
  }

  get throttle(): number {
    return this.frameScale;
  }
}

const MIN_FRAME_SCALE = 0.3;
