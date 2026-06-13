// Unit tests for the bounded LRU-TTL cache (api/src/middleware/lru-ttl-cache.ts).
//
// No network I/O, no DB, no Supabase. All time-sensitive tests use
// vi.useFakeTimers() to move the clock deterministically.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLruTtlCache } from '../src/middleware/lru-ttl-cache';

afterEach(() => {
  vi.useRealTimers();
});

describe('createLruTtlCache', () => {
  // (a) Bounded eviction is LRU, not clear-all
  it('evicts the single oldest entry on overflow (not clear-all)', () => {
    const cache = createLruTtlCache<string>(3);
    cache.set('k1', 'v1', 60_000);
    cache.set('k2', 'v2', 60_000);
    cache.set('k3', 'v3', 60_000);
    // Inserting k4 should evict k1 (oldest), keeping k2, k3, k4.
    cache.set('k4', 'v4', 60_000);
    expect(cache.size()).toBe(3);
    expect(cache.get('k1')).toBeUndefined(); // evicted
    expect(cache.get('k2')).toBe('v2');
    expect(cache.get('k3')).toBe('v3');
    expect(cache.get('k4')).toBe('v4');
  });

  // (b) get() refreshes recency, shifting which entry is the eviction candidate
  it('get() refreshes LRU recency so the accessed entry survives next overflow', () => {
    const cache = createLruTtlCache<string>(3);
    cache.set('k1', 'v1', 60_000);
    cache.set('k2', 'v2', 60_000);
    cache.set('k3', 'v3', 60_000);
    // Access k1 — now k2 is the oldest.
    cache.get('k1');
    // Inserting k4 should evict k2 (now the least-recently-used).
    cache.set('k4', 'v4', 60_000);
    expect(cache.size()).toBe(3);
    expect(cache.get('k2')).toBeUndefined(); // evicted
    expect(cache.get('k1')).toBe('v1');      // survived
    expect(cache.get('k3')).toBe('v3');
    expect(cache.get('k4')).toBe('v4');
  });

  // (c) TTL expiry: get() returns undefined after the entry expires
  it('returns undefined and shrinks size after TTL expires', () => {
    vi.useFakeTimers();
    const cache = createLruTtlCache<string>(10);
    cache.set('k1', 'v1', 100); // expires in 100 ms
    expect(cache.get('k1')).toBe('v1');  // live at t=0
    vi.advanceTimersByTime(101);
    expect(cache.get('k1')).toBeUndefined(); // expired at t=101
    expect(cache.size()).toBe(0);            // lazy eviction on get
  });

  // (d) get() does NOT extend expiry — recency refresh != TTL refresh
  it('get() does not extend expiry (revocation remains bounded by TTL)', () => {
    vi.useFakeTimers();
    const cache = createLruTtlCache<string>(10);
    cache.set('k1', 'v1', 100); // expires at t=100
    vi.advanceTimersByTime(60);
    expect(cache.get('k1')).toBe('v1');  // live at t=60; recency refreshed
    vi.advanceTimersByTime(60);          // now t=120, past the original expiry
    // If get() had extended the TTL, k1 would still be live here.
    // It must be undefined, proving expiry is NOT extended.
    expect(cache.get('k1')).toBeUndefined();
  });

  // Additional: updating an existing key refreshes its recency position
  it('set() on an existing key refreshes its recency (update path)', () => {
    const cache = createLruTtlCache<string>(3);
    cache.set('k1', 'v1', 60_000);
    cache.set('k2', 'v2', 60_000);
    cache.set('k3', 'v3', 60_000);
    // Re-set k1 — it moves to MRU, making k2 the new LRU.
    cache.set('k1', 'v1-updated', 60_000);
    expect(cache.size()).toBe(3);
    cache.set('k4', 'v4', 60_000);      // should evict k2
    expect(cache.get('k2')).toBeUndefined();
    expect(cache.get('k1')).toBe('v1-updated');
    expect(cache.get('k3')).toBe('v3');
    expect(cache.get('k4')).toBe('v4');
  });

  // Additional: clear() empties the cache
  it('clear() removes all entries', () => {
    const cache = createLruTtlCache<string>(10);
    cache.set('k1', 'v1', 60_000);
    cache.set('k2', 'v2', 60_000);
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get('k1')).toBeUndefined();
    expect(cache.get('k2')).toBeUndefined();
  });
});
