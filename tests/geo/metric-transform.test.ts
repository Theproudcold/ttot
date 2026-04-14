import { describe, expect, it } from 'vitest';

import { createMetricTransform, isLikelyProjectedCrs } from '@/shared/geo/crs';

describe('isLikelyProjectedCrs', () => {
  it('treats known geographic EPSG codes as geographic regardless of casing', () => {
    expect(isLikelyProjectedCrs('epsg:4326')).toBe(false);
    expect(isLikelyProjectedCrs('EPSG:4490')).toBe(false);
    expect(isLikelyProjectedCrs('epsg:4269')).toBe(false);
    expect(isLikelyProjectedCrs('crs:84')).toBe(false);
  });
});

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
      crsCode: 'EPSG:4490',
      boundingBox: [119.420001, 36.510001, 119.420901, 36.510601],
    });

    const metricLeftBottom = transform.toMetric([119.420001, 36.510001]);
    const metricRightTop = transform.toMetric([119.420901, 36.510601]);

    expect(transform.coordinateDisplayMode).toBe('geographic');
    expect(metricLeftBottom[0]).toBeCloseTo(-40.262864, 3);
    expect(metricLeftBottom[1]).toBeCloseTo(-33.395847, 3);
    expect(metricRightTop[0]).toBeCloseTo(40.262864, 3);
    expect(metricRightTop[1]).toBeCloseTo(33.395847, 3);
    expect(transform.metricWidth).toBeCloseTo(80.525727, 3);
    expect(transform.metricHeight).toBeCloseTo(66.791694, 3);
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

  it('rejects bounding boxes with non-finite values', () => {
    expect(() =>
      createMetricTransform({
        crsCode: 'EPSG:4326',
        boundingBox: [119.42, Number.NaN, 119.421, 36.511],
      }),
    ).toThrow('bounding box must contain only finite numbers');
  });

  it('rejects reversed bounding boxes', () => {
    expect(() =>
      createMetricTransform({
        crsCode: 'EPSG:4549',
        boundingBox: [448017.58, 4041573.05, 447934.57, 4041619.78],
      }),
    ).toThrow('bounding box must be ordered as [minX, minY, maxX, maxY]');
  });

  it('rejects geographic transforms too close to the poles', () => {
    expect(() =>
      createMetricTransform({
        crsCode: 'EPSG:4326',
        boundingBox: [10, 89.999999, 10.0001, 90],
      }),
    ).toThrow('geographic metric transform is unstable near the poles');
  });
});
