import { describe, expect, it } from 'vitest';

import { createMetricTransform } from '@/shared/geo/crs';

describe('createMetricTransform', () => {
  it('returns identity metric transform for projected coordinates', () => {
    const transform = createMetricTransform({
      crsCode: 'EPSG:4549',
      boundingBox: [447934.57, 4041573.05, 448017.58, 4041619.78],
    });

    expect(transform.coordinateDisplayMode).toBe('projected');
    expect(transform.toMetric([10, 20])).toEqual([10, 20]);
    expect(transform.fromMetric([10, 20])).toEqual([10, 20]);
  });

  it('converts geographic coordinates into local metric coordinates', () => {
    const transform = createMetricTransform({
      crsCode: 'EPSG:4326',
      boundingBox: [119.420001, 36.510001, 119.420901, 36.510601],
    });

    const metricLeftBottom = transform.toMetric([119.420001, 36.510001]);
    const metricRightTop = transform.toMetric([119.420901, 36.510601]);

    expect(metricRightTop[0]).toBeGreaterThan(metricLeftBottom[0]);
    expect(metricRightTop[1]).toBeGreaterThan(metricLeftBottom[1]);
    expect(transform.metricWidth).toBeGreaterThan(0);
    expect(transform.metricHeight).toBeGreaterThan(0);
  });

  it('round-trips geographic coordinates through local metric transform', () => {
    const transform = createMetricTransform({
      crsCode: 'EPSG:4326',
      boundingBox: [119.42, 36.51, 119.421, 36.511],
    });

    const original: [number, number] = [119.4205, 36.5105];
    const roundTrip = transform.fromMetric(transform.toMetric(original));

    expect(roundTrip[0]).toBeCloseTo(original[0], 6);
    expect(roundTrip[1]).toBeCloseTo(original[1], 6);
  });
});
