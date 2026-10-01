import { applyTunables, benchSpecKey, measureBenchSpec, type BenchMeasure, type BenchSpec, type TunableValues } from '@rune/shared';

/** Results kept per set and row; a long editing session cannot grow the cache without end. */
const CACHE_LIMIT = 5000;

/**
 * Measures bench rows under a tuning set. The config objects are overwritten in place by
 * `applyTunables`, so this runs in the bench's own worker (measure.worker.ts) where nothing else
 * reads them; a set is applied only when the next row needs a different one.
 */
export class BenchMeasurer {
  private applied: string | null = null;
  private readonly cache = new Map<string, BenchMeasure>();

  measure(setKey: string, values: Readonly<TunableValues>, spec: BenchSpec): BenchMeasure {
    const key = `${setKey}#${benchSpecKey(spec)}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    if (this.applied !== setKey) {
      applyTunables(values);
      this.applied = setKey;
    }
    const m = measureBenchSpec(spec);
    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, m);
    return m;
  }

  cached(setKey: string, spec: BenchSpec): BenchMeasure | undefined {
    return this.cache.get(`${setKey}#${benchSpecKey(spec)}`);
  }
}
