import { describe, expect, it } from 'vitest';

import {
  buildFenceFeature,
  clipFenceToBoundingBox,
  clipFenceToValidityMask,
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

describe('clipFenceToBoundingBox', () => {
  it('keeps fence unchanged when fully inside bounding box', () => {
    const rings: FenceRings = [
      [
        [1, 1],
        [3, 1],
        [3, 3],
        [1, 3],
        [1, 1],
      ],
    ];
    const clipped = clipFenceToBoundingBox(rings, [0, 0, 5, 5]);
    expect(clipped).toEqual(rings);
  });

  it('clips a polygon that exceeds the bounding box on one side', () => {
    const rings: FenceRings = [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
    ];
    const clipped = clipFenceToBoundingBox(rings, [2, 2, 8, 8]);
    const summary = getFenceSummary(clipped);
    expect(summary.bbox).toEqual([2, 2, 8, 8]);
    expect(summary.area).toBe(36);
    expect(summary.vertexCount).toBe(4);
  });

  it('clips a polygon that exceeds on all sides', () => {
    const rings: FenceRings = [
      [
        [-5, -5],
        [15, -5],
        [15, 15],
        [-5, 15],
        [-5, -5],
      ],
    ];
    const clipped = clipFenceToBoundingBox(rings, [0, 0, 10, 10]);
    const summary = getFenceSummary(clipped);
    expect(summary.bbox).toEqual([0, 0, 10, 10]);
    expect(summary.area).toBe(100);
    expect(summary.vertexCount).toBe(4);
  });

  it('returns a nearly-empty ring when polygon lies completely outside bounding box', () => {
    const rings: FenceRings = [
      [
        [20, 20],
        [30, 20],
        [30, 30],
        [20, 30],
        [20, 20],
      ],
    ];
    const clipped = clipFenceToBoundingBox(rings, [0, 0, 10, 10]);
    expect(clipped[0].length).toBeLessThan(4);
  });
});

describe('clipFenceToValidityMask', () => {
  it('clips a polygon to the valid pixel outline', () => {
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

    const rings: FenceRings = [
      [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
        [0, 0],
      ],
    ];

    const clipped = clipFenceToValidityMask(rings, validityMask);
    expect(clipped[0].length).toBeGreaterThanOrEqual(4);
    expect(isFenceInsideValidityMask(clipped, validityMask)).toBe(true);
  });

  it('returns empty ring when no valid pixels are inside the fence', () => {
    const validityMask: RasterValidityMask = {
      width: 4,
      height: 4,
      boundingBox: [0, 0, 4, 4],
      data: new Uint8Array(16).fill(0),
    };

    const rings: FenceRings = [
      [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
        [0, 0],
      ],
    ];

    const clipped = clipFenceToValidityMask(rings, validityMask);
    expect(clipped[0].length).toBeLessThan(4);
  });
});
