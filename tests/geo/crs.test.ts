import { describe, expect, it } from 'vitest';

import { estimateGridCount, isLikelyProjectedCrs } from '@/shared/geo/crs';

describe('isLikelyProjectedCrs', () => {
  it('returns false for EPSG:4326', () => {
    expect(isLikelyProjectedCrs('EPSG:4326')).toBe(false);
  });

  it('returns true for projected meter-based crs', () => {
    expect(isLikelyProjectedCrs('EPSG:3857')).toBe(true);
  });
});

describe('estimateGridCount', () => {
  it('estimates rows, cols and total from metric extent', () => {
    expect(
      estimateGridCount(
        {
          minX: 0,
          minY: 0,
          maxX: 100,
          maxY: 100,
        },
        0.5,
      ),
    ).toEqual({
      rows: 200,
      cols: 200,
      total: 40000,
    });
  });

  it('throws when cell size is not positive', () => {
    expect(() =>
      estimateGridCount(
        {
          minX: 0,
          minY: 0,
          maxX: 10,
          maxY: 10,
        },
        0,
      ),
    ).toThrow('cell size must be greater than 0');
  });
});
