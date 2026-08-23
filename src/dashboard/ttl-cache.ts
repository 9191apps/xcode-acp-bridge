export type TtlCache<T> = {
  /** Cached value, recomputed when the entry is older than `ttlMs`. */
  get(): T;
  /** Drops the cached value so the next `get()` recomputes. */
  invalidate(): void;
};

/**
 * Single-slot memoization with a wall-clock expiry, for probes that are too
 * expensive to run per request but too cheap to warrant a background refresher
 * (e.g. the synchronous backend auth `spawnSync` calls behind
 * `GET /api/app/status`). Failures are never cached, so a transient probe error
 * doesn't stick around for a whole TTL window.
 */
export function createTtlCache<T>(options: {
  ttlMs: number;
  load: () => T;
  now?: () => number;
}): TtlCache<T> {
  const now = options.now ?? Date.now;
  let entry: { value: T; loadedAt: number } | null = null;

  return {
    get(): T {
      const current = now();
      if (entry && current - entry.loadedAt < options.ttlMs) {
        return entry.value;
      }
      const value = options.load();
      entry = { value, loadedAt: current };
      return value;
    },
    invalidate(): void {
      entry = null;
    },
  };
}
