const assert = require('node:assert/strict');
const test = require('node:test');
const { createSolutionCache } = require('./solutionCache');

test('cache entries expire at a fixed TTL even when read repeatedly', async () => {
  let time = 0;
  let calls = 0;
  const cache = createSolutionCache({ ttlMs: 100, maxEntries: 2, now: () => time });
  const create = () => ++calls;
  assert.equal((await cache.getOrCreate('a', create)).value, 1);
  time = 99;
  assert.equal((await cache.getOrCreate('a', create)).cacheHit, true);
  time = 100;
  const expired = await cache.getOrCreate('a', create);
  assert.equal(expired.cacheHit, false);
  assert.equal(expired.value, 2);
});

test('capacity evicts the least recently read entry', async () => {
  const cache = createSolutionCache({ maxEntries: 2 });
  const create = () => 'answer';
  await cache.getOrCreate('a', create);
  await cache.getOrCreate('b', create);
  await cache.getOrCreate('a', create);
  await cache.getOrCreate('c', create);
  assert.equal((await cache.getOrCreate('a', create)).cacheHit, true);
  assert.equal((await cache.getOrCreate('b', create)).cacheHit, false);
});

for (const setting of [{ ttlMs: 0 }, { maxEntries: 0 }]) {
  test(`zero cache setting disables storage: ${JSON.stringify(setting)}`, async () => {
    const cache = createSolutionCache(setting);
    let calls = 0;
    const create = () => ++calls;
    assert.equal((await cache.getOrCreate('a', create)).value, 1);
    assert.equal((await cache.getOrCreate('a', create)).value, 2);
  });
}
