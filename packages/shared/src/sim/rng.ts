/** mulberry32: small, fast and good enough for gameplay rolls. State is one uint32 so it snapshots trivially. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /**
   * An independent stream derived from this one's seed and a label. Systems draw from their own
   * stream, so adding a roll to loot does not shift combat or spawn outcomes for the same seed.
   */
  static stream(seed: number, label: string): Rng {
    let h = seed >>> 0;
    for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
    return new Rng(h);
  }

  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }
}
