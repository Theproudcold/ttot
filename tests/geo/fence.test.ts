import { describe, expect, it } from 'vitest';

import {
  buildFenceFeature,
  getFenceSummary,
  isCoordinateInValidityMask,
  isFenceInsideValidityMask,
} from '@/shared/geo/fence';
import type { FenceRings } from '@/shared/types/fence';
import type { RasterValidityMask } from '@/shared/types/raster';

const POLYGON_COORDINATES: FenceRings = [
  [
    [0, 0],
    [10, 0],
    [10, 20],
    [0, 20],
    [0, 0],
  ],
];

describe('getFenceSummary', () => {
  it('computes projected area, extent and vertex count from polygon rings', () => {
    const summary = getFenceSummary(POLYGON_COORDINATES);

    expect(summary).toEqual({
      area: 200,
      bbox: [0, 0, 10, 20],
      vertexCount: 4,
    });
  });
});

describe('buildFenceFeature', () => {
  it('wraps polygon coordinates into a serializable fence feature', () => {
    const feature = buildFenceFeature(POLYGON_COORDINATES);

    expect(feature.summary.area).toBe(200);
    expect(feature.summary.vertexCount).toBe(4);
    expect(feature.geometry.type).toBe('Polygon');
  });
});

describe('raster validity guard', () => {
  const validityMask: RasterValidityMask = {
    width: 4,
    height: 4,
    boundingBox: [0, 0, 4, 4],
    data: new Uint8Array([
      0, 0, 0, 0,
      0, 1, 1, 0,
      0, 1, 1, 0,
      0, 0, 0, 0,
    ]),
  };

  it('checks whether a coordinate falls inside raster valid data', () => {
    expect(isCoordinateInValidityMask([1.5, 2.5], validityMask)).toBe(true);
    expect(isCoordinateInValidityMask([0.5, 0.5], validityMask)).toBe(false);
    expect(isCoordinateInValidityMask([5, 5], validityMask)).toBe(false);
  });

  it('rejects fences that cross invalid raster area', () => {
    expect(
      isFenceInsideValidityMask(
        [
          [
            [1.25, 1.25],
            [2.75, 1.25],
            [2.75, 2.75],
            [1.25, 2.75],
            [1.25, 1.25],
          ],
        ],
        validityMask,
      ),
    ).toBe(true);

    expect(
      isFenceInsideValidityMask(
        [
          [
            [0.5, 0.5],
            [2.75, 0.5],
            [2.75, 2.75],
            [0.5, 2.75],
            [0.5, 0.5],
          ],
        ],
        validityMask,
      ),
    ).toBe(false);
  });
});
