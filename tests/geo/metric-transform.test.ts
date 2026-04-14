import { describe, expect, it } from 'vitest';

import { createMetricTransform, isLikelyProjectedCrs } from '@/shared/geo/crs';

describe('isLikelyProjectedCrs', () => {
  it('treats known geographic EPSG codes as geographic regardless of casing', () => {
    expect(isLikelyProjectedCrs('epsg:4326')).toBe(false);
    expect(isLikelyProjectedCrs('EPSG:4490')).toBe(false);
    expect(isLikelyProjectedCrs('epsg:4269')).toBe(false);
    expect(isLikelyProjectedCrs('crs:84')).toBe(false);
    expect(isLikelyProjectedCrs('http://www.opengis.net/def/crs/OGC/1.3/CRS84')).toBe(false);
  });

  it('keeps unknown or non-geographic CRS values on the projected side', () => {
    expect(isLikelyProjectedCrs('EPSG:4087')).toBe(true);
    expect(isLikelyProjectedCrs('EPSG:4326foo')).toBe(true);
  });
});

describe('createMetricTransform', () => {
  it('returns identity metric transform for projected coordinates', () => {
    const transform = createMetricTransform({
      crsCode: 'EPSG:4549',
      boundingBox: [447934.57, 4041573.05, 448017.58, 4041619.78],
    });
    const sourcePoint: [number, number] = [10, 20];
    const metricPoint = transform.toMetric(sourcePoint);
    const displayPoint = transform.fromMetric(sourcePoint);

    expect(transform.coordinateDisplayMode).toBe('projected');
    expect(metricPoint).toEqual([10, 20]);
    expect(displayPoint).toEqual([10, 20]);
    expect(metricPoint).not.toBe(sourcePoint);
    expect(displayPoint).not.toBe(sourcePoint);
  });

  it('uses an explicit unknown display mode for unknown CRS values', () => {
    const transform = createMetricTransform({
      crsCode: 'UNKNOWN',
      boundingBox: [10, 20, 11, 21],
    });

    expect(transform.coordinateDisplayMode).toBe('unknown');
    expect(transform.metricExtent).toEqual({
      minX: 10,
      minY: 20,
      maxX: 11,
      maxY: 21,
    });
    expect(transform.toMetric([10.25, 20.75])).toEqual([10.25, 20.75]);
    expect(transform.fromMetric([10.25, 20.75])).toEqual([10.25, 20.75]);
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

  it('supports standard CRS84 URI as geographic coordinates', () => {
    const transform = createMetricTransform({
      crsCode: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
      boundingBox: [119.420001, 36.510001, 119.420901, 36.510601],
    });

    expect(transform.coordinateDisplayMode).toBe('geographic');
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

  it('rejects geographic bounding boxes outside valid latitude range', () => {
    expect(() =>
      createMetricTransform({
        crsCode: 'EPSG:4326',
        boundingBox: [119.42, -90.1, 119.421, -89.9],
      }),
    ).toThrow('geographic bounding box latitude must be within [-90, 90]');
  });

  it('treats dirty EPSG strings as projected instead of geographic', () => {
    const transform = createMetricTransform({
      crsCode: 'EPSG:4326foo',
      boundingBox: [119.42, 36.51, 119.421, 36.511],
    });

    expect(transform.coordinateDisplayMode).toBe('projected');
    expect(transform.toMetric([1, 2])).toEqual([1, 2]);
    expect(transform.fromMetric([3, 4])).toEqual([3, 4]);
  });

  it('rejects geographic bounding boxes that exceed the local metric limit', () => {
    expect(() =>
      createMetricTransform({
        crsCode: 'EPSG:4326',
        boundingBox: [100, 30, 102, 31],
      }),
    ).toThrow('geographic bounding box exceeds local metric transform limit');
  });
});
