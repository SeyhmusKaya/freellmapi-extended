import crypto from 'crypto';

/**
 * Tiny in-memory LRU cache with TTL, used to memoise deterministic provider
 * results (embeddings, rerank). Same input → same vectors / ranking, so a
 * repeated call can be served locally instead of spending free-tier quota.
 *
 * Safety properties (why this cannot break or stale the system):
 *  - In-memory only — lost on restart, never persisted, no schema impact.
 *  - Keyed by the full request shape (model + params + a hash of the input),
 *    so a cache hit is byte-identical to what the provider would have returned.
 *  - TTL-bounded, so a model swap behind 'auto' cannot serve forever.
 *  - Size-bounded LRU, so memory cannot grow unbounded.
 *  - Only successful results are ever inserted (callers cache after success).
 */

interface Entry<V> { value: V; expires: number }

export class ResultCache<V> {
  private map = new Map<string, Entry<V>>();
  constructor(
    private readonly maxEntries = 500,
    private readonly ttlMs = 60 * 60 * 1000, // 1h
  ) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expires) { this.map.delete(key); return undefined; }
    // LRU touch: re-insert to move to the end of iteration order.
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
    // Evict oldest while over capacity.
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number { return this.map.size; }
}

/** Stable hash of an arbitrary JSON-serialisable value. */
export function hashKey(...parts: unknown[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
