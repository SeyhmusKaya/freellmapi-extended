import { describe, it, expect } from 'vitest';
import { ResultCache, hashKey } from '../../lib/resultCache.js';

describe('ResultCache', () => {
  it('returns a stored value', () => {
    const c = new ResultCache<number>(10, 60_000);
    c.set('a', 1);
    expect(c.get('a')).toBe(1);
    expect(c.get('missing')).toBeUndefined();
  });

  it('expires entries past their TTL', async () => {
    const c = new ResultCache<number>(10, 5);
    c.set('a', 1);
    await new Promise(r => setTimeout(r, 12));
    expect(c.get('a')).toBeUndefined();
  });

  it('evicts the least-recently-used entry past capacity', () => {
    const c = new ResultCache<number>(2, 60_000);
    c.set('a', 1);
    c.set('b', 2);
    c.get('a');          // touch a → b is now LRU
    c.set('c', 3);       // over capacity → evict b
    expect(c.get('a')).toBe(1);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('c')).toBe(3);
  });

  it('hashKey is stable and order-sensitive', () => {
    expect(hashKey('x', [1, 2])).toBe(hashKey('x', [1, 2]));
    expect(hashKey('x', [1, 2])).not.toBe(hashKey('x', [2, 1]));
  });
});
