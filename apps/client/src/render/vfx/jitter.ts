/**
 * A random flicker that holds each value for a while. A fresh random value every frame strobed at
 * the refresh rate (a lightning zone's light, a shocked monster's tint); holding each one for a
 * tenth of a second reads as crackling instead.
 */
export const JITTER_HOLD = 0.1;
export const JITTER_RANGE = 0.15;

export class HeldJitter {
  private left = 0;
  private current = 1;

  constructor(
    private readonly range = JITTER_RANGE,
    private readonly hold = JITTER_HOLD,
    private readonly random: () => number = Math.random,
  ) {}

  /** Advances by `dt` and returns the held value, 1 plus or minus `range`. */
  next(dt: number): number {
    this.left -= dt;
    if (this.left <= 0) {
      this.left += this.hold;
      if (this.left <= 0) this.left = this.hold;
      this.current = 1 + (this.random() * 2 - 1) * this.range;
    }
    return this.current;
  }
}
