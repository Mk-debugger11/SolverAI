/** Bounded LRU cache with fixed expiry and shared work for identical pending keys. */
function createSolutionCache({ ttlMs = 15 * 60 * 1000, maxEntries = 200, now = Date.now } = {}) {
  const entries = new Map();
  const pending = new Map();

  return {
    async getOrCreate(key, create) {
      const existing = entries.get(key);
      if (existing && existing.expiresAt > now()) {
        entries.delete(key);
        entries.set(key, existing);
        return { value: existing.value, cacheHit: true, deduplicated: false };
      }
      entries.delete(key);

      if (pending.has(key)) {
        return { value: await pending.get(key), cacheHit: false, deduplicated: true };
      }

      const work = Promise.resolve().then(create).then((value) => {
        if (ttlMs > 0 && maxEntries > 0) {
          const timestamp = now();
          for (const [cachedKey, entry] of entries) {
            if (entry.expiresAt <= timestamp) entries.delete(cachedKey);
          }
          entries.set(key, { value, expiresAt: timestamp + ttlMs });
          while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
        }
        return value;
      }).finally(() => pending.delete(key));
      pending.set(key, work);
      return { value: await work, cacheHit: false, deduplicated: false };
    },
  };
}

module.exports = { createSolutionCache };
