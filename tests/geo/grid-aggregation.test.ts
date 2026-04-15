import { describe, expect, it, vi } from 'vitest';

import { createMetricTransform } from '@/shared/geo/crs';
import {
  aggregateGridCellsFromRasterWindow,
  aggregateGridCellsFromRasterWindowAsync,
  applyGridAggregationToBands,
} from '@/shared/geo/gridAggregation';
import type { FenceRings } from '@/shared/types/fence';
import type { GridAggregationResult } from '@/shared/types/grid';
import type { RasterOrigin, RasterResolution } from '@/shared/types/raster';

const fenceRings: FenceRings = [
  [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
    [0, 0],
  ],
];

const origin: RasterOrigin = [0, 2, 0];
const resolution: RasterResolution = [1, -1, 0];

const baseInput = {
  window: [0, 0, 2, 2] as [number, number, number, number],
  width: 2,
  height: 2,
  origin,
  resolution,
  fenceRings,
  gridCellWidth: 1,
  gridCellHeight: 1,
};

describe('gridAggregation', () => {
  it('throws when grid cell size is not positive', () => {
    expect(() =>
      aggregateGridCellsFromRasterWindow({
        ...baseInput,
        gridCellWidth: 0,
        band: new Float32Array([1, 3, 5, 7]),
        noDataValue: null,
      }),
    ).toThrow('cell size must be greater than 0');
  });

  it('throws when grid cell size is not a finite positive number', () => {
    expect(() =>
      aggregateGridCellsFromRasterWindow({
        ...baseInput,
        gridCellWidth: Number.NaN,
        band: new Float32Array([1, 3, 5, 7]),
        noDataValue: null,
      }),
    ).toThrow('cell size must be greater than 0');

    expect(() =>
      applyGridAggregationToBands({
        bands: [new Float32Array([1, 3, 5, 7])],
        aggregation: { cellsById: {} },
        width: 2,
        height: 2,
        window: [0, 0, 2, 2],
        origin,
        resolution,
        fenceRings,
        gridCellWidth: Number.POSITIVE_INFINITY,
        gridCellHeight: 1,
        noDataValue: -9999,
      }),
    ).toThrow('cell size must be greater than 0');
  });

  it('aggregates valid primary-band pixels into per-cell mean values using minY-origin row numbering', () => {
    const result = aggregateGridCellsFromRasterWindow({
      ...baseInput,
      band: new Float32Array([1, 3, 5, 7]),
      noDataValue: null,
    });

    expect(result.cellsById['r1-c0']).toMatchObject({
      cellId: 'r1-c0',
      row: 1,
      col: 0,
      pixelCount: 1,
      validPixelCount: 1,
      sumValue: 1,
      meanValue: 1,
      outputValue: 1,
    });
    expect(result.cellsById['r0-c1']).toMatchObject({
      cellId: 'r0-c1',
      row: 0,
      col: 1,
      pixelCount: 1,
      validPixelCount: 1,
      meanValue: 7,
      outputValue: 7,
    });
  });

  it('computes mean values from multiple pixels in the same grid cell', () => {
    const result = aggregateGridCellsFromRasterWindow({
      window: [0, 0, 4, 2],
      width: 4,
      height: 2,
      origin: [0, 2, 0],
      resolution: [1, -1, 0],
      fenceRings: [
        [
          [0, 0],
          [4, 0],
          [4, 2],
          [0, 2],
          [0, 0],
        ],
      ],
      gridCellWidth: 2,
      gridCellHeight: 2,
      band: new Float32Array([1, 3, 5, 7, 9, 11, 13, 15]),
      noDataValue: null,
    });

    expect(result.cellsById['r0-c0']).toMatchObject({
      pixelCount: 4,
      validPixelCount: 4,
      sumValue: 24,
      meanValue: 6,
      outputValue: 6,
    });
    expect(result.cellsById['r0-c1']).toMatchObject({
      pixelCount: 4,
      validPixelCount: 4,
      sumValue: 40,
      meanValue: 10,
      outputValue: 10,
    });
  });

  it('skips nodata pixels when computing mean values', () => {
    const result = aggregateGridCellsFromRasterWindow({
      ...baseInput,
      band: new Float32Array([1, -9999, 5, 7]),
      noDataValue: -9999,
    });

    expect(result.cellsById['r1-c1']).toMatchObject({
      pixelCount: 1,
      validPixelCount: 0,
      sumValue: 0,
      meanValue: null,
      outputValue: null,
    });
  });

  it('skips non-finite values when computing mean values', () => {
    const result = aggregateGridCellsFromRasterWindow({
      ...baseInput,
      band: new Float32Array([1, Number.NaN, Number.POSITIVE_INFINITY, 7]),
      noDataValue: null,
    });

    expect(result.cellsById['r1-c1']).toMatchObject({
      pixelCount: 1,
      validPixelCount: 0,
      sumValue: 0,
      meanValue: null,
      outputValue: null,
    });
    expect(result.cellsById['r0-c0']).toMatchObject({
      pixelCount: 1,
      validPixelCount: 0,
      sumValue: 0,
      meanValue: null,
      outputValue: null,
    });
  });

  it('uses max aggregation mode to set outputValue to the maximum valid pixel', () => {
    const result = aggregateGridCellsFromRasterWindow({
      window: [0, 0, 4, 2],
      width: 4,
      height: 2,
      origin: [0, 2, 0],
      resolution: [1, -1, 0],
      fenceRings: [
        [
          [0, 0],
          [4, 0],
          [4, 2],
          [0, 2],
          [0, 0],
        ],
      ],
      gridCellWidth: 2,
      gridCellHeight: 2,
      band: new Float32Array([1, 3, 5, 7, 9, 11, 13, 15]),
      noDataValue: null,
      aggregationMode: 'max',
    });

    expect(result.cellsById['r0-c0']).toMatchObject({
      pixelCount: 4,
      validPixelCount: 4,
      meanValue: 6,
      minValue: 1,
      maxValue: 11,
      outputValue: 11,
    });
    expect(result.cellsById['r0-c1']).toMatchObject({
      pixelCount: 4,
      validPixelCount: 4,
      meanValue: 10,
      minValue: 5,
      maxValue: 15,
      outputValue: 15,
    });
  });

  it('uses min aggregation mode to set outputValue to the minimum valid pixel', () => {
    const result = aggregateGridCellsFromRasterWindow({
      window: [0, 0, 4, 2],
      width: 4,
      height: 2,
      origin: [0, 2, 0],
      resolution: [1, -1, 0],
      fenceRings: [
        [
          [0, 0],
          [4, 0],
          [4, 2],
          [0, 2],
          [0, 0],
        ],
      ],
      gridCellWidth: 2,
      gridCellHeight: 2,
      band: new Float32Array([1, 3, 5, 7, 9, 11, 13, 15]),
      noDataValue: null,
      aggregationMode: 'min',
    });

    expect(result.cellsById['r0-c0']).toMatchObject({
      pixelCount: 4,
      validPixelCount: 4,
      meanValue: 6,
      minValue: 1,
      maxValue: 11,
      outputValue: 1,
    });
    expect(result.cellsById['r0-c1']).toMatchObject({
      pixelCount: 4,
      validPixelCount: 4,
      meanValue: 10,
      minValue: 5,
      maxValue: 15,
      outputValue: 5,
    });
  });

  it('skips nodata pixels when computing min and max values', () => {
    const result = aggregateGridCellsFromRasterWindow({
      window: [0, 0, 4, 2],
      width: 4,
      height: 2,
      origin: [0, 2, 0],
      resolution: [1, -1, 0],
      fenceRings: [
        [
          [0, 0],
          [4, 0],
          [4, 2],
          [0, 2],
          [0, 0],
        ],
      ],
      gridCellWidth: 2,
      gridCellHeight: 2,
      band: new Float32Array([1, -9999, 5, 7, 9, Number.NaN, 13, 15]),
      noDataValue: -9999,
      aggregationMode: 'max',
    });

    expect(result.cellsById['r0-c0']).toMatchObject({
      validPixelCount: 2,
      meanValue: (1 + 9) / 2,
      minValue: 1,
      maxValue: 9,
      outputValue: 9,
    });
    expect(result.cellsById['r0-c1']).toMatchObject({
      validPixelCount: 4,
      meanValue: (5 + 7 + 13 + 15) / 4,
      minValue: 5,
      maxValue: 15,
      outputValue: 15,
    });
  });

  it('matches synchronous aggregation while yielding control between row chunks', async () => {
    const yieldControl = vi.fn(async () => undefined);
    const syncResult = aggregateGridCellsFromRasterWindow({
      window: [0, 0, 4, 3],
      width: 4,
      height: 3,
      origin: [0, 3, 0],
      resolution: [1, -1, 0],
      fenceRings: [
        [
          [0, 0],
          [4, 0],
          [4, 3],
          [0, 3],
          [0, 0],
        ],
      ],
      gridCellWidth: 2,
      gridCellHeight: 1,
      band: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
      noDataValue: null,
    });

    const asyncResult = await aggregateGridCellsFromRasterWindowAsync(
      {
        window: [0, 0, 4, 3],
        width: 4,
        height: 3,
        origin: [0, 3, 0],
        resolution: [1, -1, 0],
        fenceRings: [
          [
            [0, 0],
            [4, 0],
            [4, 3],
            [0, 3],
            [0, 0],
          ],
        ],
        gridCellWidth: 2,
        gridCellHeight: 1,
        band: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
        noDataValue: null,
      },
      {
        rowsPerChunk: 1,
        yieldControl,
      },
    );

    expect(asyncResult).toEqual(syncResult);
    expect(yieldControl).toHaveBeenCalledTimes(2);
  });

  it('does not create buckets for non-hit cells inside the fence bounding box', () => {
    const result = aggregateGridCellsFromRasterWindow({
      window: [0, 0, 3, 3],
      width: 3,
      height: 3,
      origin: [0, 3, 0],
      resolution: [1, -1, 0],
      fenceRings: [
        [
          [0, 0],
          [3, 0],
          [3, 3],
          [0, 3],
          [0, 0],
        ],
        [
          [1, 1],
          [2, 1],
          [2, 2],
          [1, 2],
          [1, 1],
        ],
      ],
      gridCellWidth: 1,
      gridCellHeight: 1,
      band: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
      noDataValue: null,
    });

    expect(result.cellsById['r1-c1']).toBeUndefined();
    expect(Object.keys(result.cellsById)).toHaveLength(8);
    expect(result.cellsById['r0-c0']).toBeDefined();
    expect(result.cellsById['r2-c2']).toBeDefined();
  });

  it('rewrites raster bands with per-cell output values and keeps non-hit cells as nodata', () => {
    const aggregation: GridAggregationResult = {
      cellsById: {
        'r1-c0': {
          cellId: 'r1-c0',
          row: 1,
          col: 0,
          pixelCount: 1,
          validPixelCount: 1,
          sumValue: 10,
          meanValue: 10,
          minValue: 10,
          maxValue: 10,
          outputValue: 10,
        },
      },
    };

    const result = applyGridAggregationToBands({
      bands: [new Float32Array([1, 3, 5, 7])],
      aggregation,
      width: 2,
      height: 2,
      window: [0, 0, 2, 2],
      origin,
      resolution,
      fenceRings,
      gridCellWidth: 1,
      gridCellHeight: 1,
      noDataValue: -9999,
    });

    expect(Array.from(result.bands[0])).toEqual([10, -9999, -9999, -9999]);
    expect(result.maskedPixelCount).toBe(3);
  });

  it('writes nodata when a hit cell has null output value', () => {
    const result = applyGridAggregationToBands({
      bands: [new Float32Array([1, 2, 3, 4])],
      aggregation: {
        cellsById: {
          'r0-c0': {
            cellId: 'r0-c0',
            row: 0,
            col: 0,
            pixelCount: 4,
            validPixelCount: 0,
            sumValue: 0,
            meanValue: null,
            minValue: null,
            maxValue: null,
            outputValue: null,
          },
        },
      },
      width: 2,
      height: 2,
      window: [0, 0, 2, 2],
      origin,
      resolution,
      fenceRings,
      gridCellWidth: 2,
      gridCellHeight: 2,
      noDataValue: -9999,
    });

    expect(Array.from(result.bands[0])).toEqual([-9999, -9999, -9999, -9999]);
  });

  it('rewrites every band with the aggregated output values', () => {
    const result = applyGridAggregationToBands({
      bands: [new Float32Array([1, 2, 3, 4]), new Float32Array([10, 20, 30, 40])],
      aggregation: {
        cellsById: {
          'r1-c0': {
            cellId: 'r1-c0',
            row: 1,
            col: 0,
            pixelCount: 1,
            validPixelCount: 1,
            sumValue: 10,
            meanValue: 10,
            minValue: 10,
            maxValue: 10,
            outputValue: 10,
          },
        },
      },
      width: 2,
      height: 2,
      window: [0, 0, 2, 2],
      origin,
      resolution,
      fenceRings,
      gridCellWidth: 1,
      gridCellHeight: 1,
      noDataValue: -9999,
    });

    expect(Array.from(result.bands[0])).toEqual([10, -9999, -9999, -9999]);
    expect(Array.from(result.bands[1])).toEqual([10, -9999, -9999, -9999]);
  });

  it('preserves high-precision output values when rewriting bands', () => {
    const preciseValue = 16777217;
    const result = applyGridAggregationToBands({
      bands: [new Float64Array([1, 2, 9, 10])],
      aggregation: {
        cellsById: {
          'r0-c0': {
            cellId: 'r0-c0',
            row: 0,
            col: 0,
            pixelCount: 4,
            validPixelCount: 4,
            sumValue: preciseValue * 4,
            meanValue: preciseValue,
            minValue: preciseValue,
            maxValue: preciseValue,
            outputValue: preciseValue,
          },
        },
      },
      width: 2,
      height: 2,
      window: [0, 0, 2, 2],
      origin,
      resolution,
      fenceRings,
      gridCellWidth: 2,
      gridCellHeight: 2,
      noDataValue: -9999,
    });

    expect(result.bands[0]).toBeInstanceOf(Float64Array);
    expect(Array.from(result.bands[0])).toEqual([
      preciseValue,
      preciseValue,
      preciseValue,
      preciseValue,
    ]);
  });

  it('preserves fractional mean values when rewriting integer typed-array bands', () => {
    const result = applyGridAggregationToBands({
      bands: [new Uint16Array([1, 2, 9, 10])],
      aggregation: {
        cellsById: {
          'r0-c0': {
            cellId: 'r0-c0',
            row: 0,
            col: 0,
            pixelCount: 4,
            validPixelCount: 4,
            sumValue: 6,
            meanValue: 1.5,
            minValue: 1,
            maxValue: 2,
            outputValue: 1.5,
          },
        },
      },
      width: 2,
      height: 2,
      window: [0, 0, 2, 2],
      origin,
      resolution,
      fenceRings,
      gridCellWidth: 2,
      gridCellHeight: 2,
      noDataValue: -9999,
    });

    expect(result.bands[0]).toBeInstanceOf(Float64Array);
    expect(Array.from(result.bands[0])).toEqual([1.5, 1.5, 1.5, 1.5]);
  });

  it('aggregates geographic raster pixels by metric grid size instead of raw degree deltas', () => {
    const geographicFenceRings: FenceRings = [
      [
        [119.420001, 36.510001],
        [119.420901, 36.510001],
        [119.420901, 36.510601],
        [119.420001, 36.510601],
        [119.420001, 36.510001],
      ],
    ];
    const metricTransform = createMetricTransform({
      crsCode: 'EPSG:4326',
      boundingBox: [119.420001, 36.510001, 119.420901, 36.510601],
    });

    const aggregation = aggregateGridCellsFromRasterWindow({
      window: [0, 0, 2, 2],
      width: 2,
      height: 2,
      origin: [119.420001, 36.510601, 0],
      resolution: [0.00045, -0.0003, 0],
      fenceRings: geographicFenceRings,
      metricTransform,
      gridCellWidth: 10,
      gridCellHeight: 10,
      band: new Float32Array([1, 3, 5, 7]),
      noDataValue: null,
    });

    expect(Object.keys(aggregation.cellsById)).toHaveLength(4);
    expect(Object.values(aggregation.cellsById).map((cell) => cell.meanValue)).toEqual([1, 3, 5, 7]);
  });

  it('rewrites geographic raster bands by metric grid cells instead of collapsing everything into one degree cell', () => {
    const geographicFenceRings: FenceRings = [
      [
        [119.420001, 36.510001],
        [119.420901, 36.510001],
        [119.420901, 36.510601],
        [119.420001, 36.510601],
        [119.420001, 36.510001],
      ],
    ];
    const metricTransform = createMetricTransform({
      crsCode: 'EPSG:4326',
      boundingBox: [119.420001, 36.510001, 119.420901, 36.510601],
    });
    const aggregation = aggregateGridCellsFromRasterWindow({
      window: [0, 0, 2, 2],
      width: 2,
      height: 2,
      origin: [119.420001, 36.510601, 0],
      resolution: [0.00045, -0.0003, 0],
      fenceRings: geographicFenceRings,
      metricTransform,
      gridCellWidth: 10,
      gridCellHeight: 10,
      band: new Float32Array([1, 3, 5, 7]),
      noDataValue: null,
    });

    const result = applyGridAggregationToBands({
      bands: [new Float32Array([1, 3, 5, 7])],
      aggregation,
      width: 2,
      height: 2,
      window: [0, 0, 2, 2],
      origin: [119.420001, 36.510601, 0],
      resolution: [0.00045, -0.0003, 0],
      fenceRings: geographicFenceRings,
      metricTransform,
      gridCellWidth: 10,
      gridCellHeight: 10,
      noDataValue: -9999,
    });

    expect(Array.from(result.bands[0])).toEqual([1, 3, 5, 7]);
    expect(result.maskedPixelCount).toBe(0);
  });
});
