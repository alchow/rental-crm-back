// Bounded LRU cache with per-entry TTL.
//
// Invariants:
//   - Map insertion order == LRU order: the FIRST key is the OLDEST (least-
//     recently-used); the LAST key is the MOST-recently-used.
//   - On get(): if the entry is live, DELETE then re-SET so it moves to the
//     end (most-recent). This refreshes LRU recency but intentionally does NOT
//     extend expiresAt.
//   - SECURITY: get() refreshes recency but NEVER extends the TTL. This means
//     a revoked member is still evicted within MEMBERSHIP_CACHE_TTL_MS of
//     revocation, regardless of how frequently their requests hit the cache.
//     If recency also extended TTL, a busy agent could hold a stale membership
//     entry indefinitely. Keeping them independent bounds the revocation
//     visibility window to the configured TTL.
//   - On set(): if inserting a NEW key would exceed `max`, evict the SINGLE
//     oldest entry (map.keys().next().value) — never clear all. This prevents
//     the thundering-herd cliff where one overflow forces every concurrent
//     request to bypass the cache simultaneously.

export interface LruTtlCache<V> {
  /** Returns the value if present AND not expired. On a live hit, refreshes
   *  LRU recency (moves to most-recently-used) but does NOT extend expiry. */
  get(key: string): V | undefined;
  /** Stores value with expiresAt = Date.now() + ttlMs. If inserting a NEW key
   *  would exceed max, evicts the single oldest entry first. Updating an
   *  existing key also refreshes its LRU recency. */
  set(key: string, value: V, ttlMs: number): void;
  size(): number;
  clear(): void;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export function createLruTtlCache<V>(max: number): LruTtlCache<V> {
  if (max < 1) throw new RangeError('LruTtlCache: max must be >= 1');

  // Map key -> Entry<V>. JS Map preserves insertion order, which gives us LRU
  // for free: first key = oldest (LRU), last key = newest (MRU).
  const map = new Map<string, Entry<V>>();

  return {
    get(key: string): V | undefined {
      const entry = map.get(key);
      if (!entry) return undefined;

      if (entry.expiresAt <= Date.now()) {
        // Expired: evict lazily, do not return stale value.
        map.delete(key);
        return undefined;
      }

      // Live hit: refresh LRU recency by moving to the end of the map.
      // We do this by deleting and re-inserting with the SAME entry object
      // (preserving the original expiresAt — recency != expiry refresh).
      map.delete(key);
      map.set(key, entry);
      return entry.value;
    },

    set(key: string, value: V, ttlMs: number): void {
      // If the key already exists, remove it first so insertion-order is
      // updated (makes it the MRU entry regardless of previous position).
      if (map.has(key)) {
        map.delete(key);
      } else if (map.size >= max) {
        // Evict single oldest (LRU) entry — the first key in the map.
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      map.set(key, { value, expiresAt: Date.now() + ttlMs });
    },

    size(): number {
      return map.size;
    },

    clear(): void {
      map.clear();
    },
  };
}
