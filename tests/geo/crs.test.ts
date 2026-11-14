import { describe, expect, it } from 'vitest';

import { createIdentityMetricTransform, estimateGridCount, getMinCellSizeFromMetadata, isLikelyProjectedCrs } from '@/shared/geo/crs';
import type { RasterMetadata } from '@/shared/types/raster';

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

describe('getMinCellSizeFromMetadata', () => {
  function createMetadata(cellSize: RasterMetadata['cellSize'], boundingBox: RasterMetadata['boundingBox']): RasterMetadata {
    return {
      sourceUrl: null,
      fileName: 'test.tif',
      width: 100,
      height: 100,
      samplesPerPixel: 1,
      boundingBox,
      coordinateDisplayMode: 'projected',
      metricExtent: { minX: boundingBox[0], minY: boundingBox[1], maxX: boundingBox[2], maxY: boundingBox[3] },
      metricWidth: boundingBox[2] - boundingBox[0],
      metricHeight: boundingBox[3] - boundingBox[1],
      metricTransform: createIdentityMetricTransform(boundingBox),
      origin: [boundingBox[0], boundingBox[3], 0],
      resolution: [1, -1, 0],
      cellSize,
      crsCode: 'EPSG:4549',
      crsName: 'EPSG:4549',
      isProjected: true,
    };
  }

  it('returns absolute minimum when metadata is null', () => {
    expect(getMinCellSizeFromMetadata(null)).toBe(0.01);
  });

  it('returns cell size in meters for projected data', () => {
    const metadata = createMetadata({ x: 0.5, y: 0.5, unit: 'm' }, [0, 0, 100, 100]);
    expect(getMinCellSizeFromMetadata(metadata)).toBe(0.5);
  });

  it('converts degree cell size to meters for geographic data', () => {
    const metadata = createMetadata({ x: 0.000001, y: 0.000001, unit: 'degree' }, [119, 36, 120, 37]);
    const latitude = 36.5;
    const scaleX = 111320 * Math.cos((latitude * Math.PI) / 180);
    const expectedMeters = 0.000001 * scaleX;
    expect(getMinCellSizeFromMetadata(metadata)).toBeCloseTo(expectedMeters, 6);
  });

  it('does not go below absolute minimum even for very small cell sizes', () => {
    const metadata = createMetadata({ x: 0.001, y: 0.001, unit: 'm' }, [0, 0, 100, 100]);
    expect(getMinCellSizeFromMetadata(metadata)).toBe(0.01);
  });

  it('does not go below absolute minimum for tiny degree cell sizes', () => {
    const metadata = createMetadata({ x: 1e-12, y: 1e-12, unit: 'degree' }, [119, 36, 120, 37]);
    expect(getMinCellSizeFromMetadata(metadata)).toBe(0.01);
  });
});
