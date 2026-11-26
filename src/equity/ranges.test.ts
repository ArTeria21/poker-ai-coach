import { describe, expect, it } from 'vitest';
import { parseRange } from './ranges';

describe('concrete ranges', () => {
  it('expands classes, plus and intervals without duplicate weighting', () => {
    expect(parseRange('TT+, AQs+, AKo')).toHaveLength(50);
    expect(parseRange('22-66')).toHaveLength(30);
    expect(parseRange('A2s-A5s')).toHaveLength(16);
    expect(parseRange('AK, AKs, AsKh, KhAs')).toHaveLength(16);
  });
  it('removes blockers and rejects malformed or empty ranges', () => {
    expect(parseRange('AA', ['As', 'Ah'])).toEqual([['Ac', 'Ad']]);
    for (const range of ['', 'AKx', 'AAs', 'AsAs', 'KAs', 'AA,,KK', 'AKs-KQs']) {
      expect(() => parseRange(range)).toThrow();
    }
    expect(() => parseRange('AsKh', ['As'])).toThrow();
  });
});
