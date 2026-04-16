import { describe, expect, it } from 'vitest';

import { createMetricTransform } from '@/shared/geo/crs';
import { buildGridPreview } from '@/shared/geo/grid';
import type { FenceRings } from '@/shared/types/fence';
import type { GridAggregationResult } from '@/shared/types/grid';

const RECTANGLE_FENCE: FenceRings = [
  [
    [0, 0],
    [10, 0],
    [10, 20],
    [0, 20],
    [0, 0],
  ],
];

const GEOGRAPHIC_FENCE: FenceRings = [
  [
    [119.420001, 36.510001],
    [119.420901, 36.510001],
    [119.420901, 36.510601],
    [119.420001, 36.510601],
    [119.420001, 36.510001],
  ],
];

describe('buildGridPreview', () => {
  it('creates metric grid cells and summary for a rectangular fence', () => {
    const preview = buildGridPreview(RECTANGLE_FENCE, 5);

    expect(preview.summary).toEqual({
      cellSize: 5,
      rows: 4,
      cols: 2,
      totalCells: 8,
      previewCellCount: 8,
      isPreviewLimited: false,
      previewStride: 1,
      warning: null,
      rotation: 0,
    });
    expect(preview.cells).toHaveLength(8);
    expect(preview.cells[0]).toMatchObject({
      id: 'r0-c0',
      center: [2.5, 2.5],
    });
  });

  it('throws when cell size is not positive', () => {
    expect(() => buildGridPreview(RECTANGLE_FENCE, 0)).toThrow('cell size must be greater than 0');
  });

  it('returns the full grid even when the estimated grid is dense', () => {
    const preview = buildGridPreview(
      [
        [
          [0, 0],
          [20, 0],
          [20, 20],
          [0, 20],
          [0, 0],
        ],
      ],
      0.1,
    );

    expect(preview.summary.totalCells).toBe(40000);
    expect(preview.summary.previewCellCount).toBe(preview.summary.totalCells);
    expect(preview.summary.isPreviewLimited).toBe(false);
    expect(preview.summary.previewStride).toBe(1);
    expect(preview.summary.warning).toBeNull();
    expect(preview.cells).toHaveLength(preview.summary.totalCells);
  });

  it('attaches aggregation details to matched grid cells without polluting summary', () => {
    const aggregation: GridAggregationResult = {
      cellsById: {
        'r0-c0': {
          cellId: 'r0-c0',
          row: 0,
          col: 0,
          pixelCount: 20,
          validPixelCount: 18,
          sumValue: 11.16,
          meanValue: 0.62,
          minValue: 0.2,
          maxValue: 0.88,
          outputValue: 0.62,
        },
      },
    };

    const preview = buildGridPreview(RECTANGLE_FENCE, 5, aggregation);

    expect(preview.cells[0]).toMatchObject({
      id: 'r0-c0',
      aggregation: aggregation.cellsById['r0-c0'],
    });
    expect(preview.cells[1].aggregation).toBeUndefined();
    expect(preview.summary).not.toHaveProperty('cellsById');
  });

  it('builds grid cells in geographic rasters using metric cell size rather than degree deltas', () => {
    const metricTransform = createMetricTransform({
      crsCode: 'EPSG:4326',
      boundingBox: [119.420001, 36.510001, 119.420901, 36.510601],
    });

    const preview = buildGridPreview(GEOGRAPHIC_FENCE, 10, metricTransform);

    expect(preview.summary.cellSize).toBe(10);
    expect(preview.summary.totalCells).toBe(63);
    expect(preview.summary.previewCellCount).toBe(63);
    expect(preview.cells[0]?.center[0]).toBeCloseTo(119.42005688, 6);
    expect(preview.cells[0]?.center[1]).toBeCloseTo(36.51004584, 6);
    expect(preview.cells.at(-1)?.center[0]).toBeCloseTo(119.42089806, 6);
    expect(preview.cells.at(-1)?.center[1]).toBeCloseTo(36.51057049, 6);
  });

  it('limits preview cells when maxPreviewCells is exceeded', () => {
    const preview = buildGridPreview(RECTANGLE_FENCE, 1, { maxPreviewCells: 50 });

    expect(preview.summary.totalCells).toBe(200);
    expect(preview.summary.previewCellCount).toBeLessThanOrEqual(50);
    expect(preview.summary.isPreviewLimited).toBe(true);
    expect(preview.summary.previewStride).toBeGreaterThan(1);
    expect(preview.summary.warning).toContain('地图仅预览采样网格');
    expect(preview.cells).toHaveLength(preview.summary.previewCellCount);
  });

  it('does not limit preview cells when count is under maxPreviewCells', () => {
    const preview = buildGridPreview(RECTANGLE_FENCE, 5, { maxPreviewCells: 50 });

    expect(preview.summary.totalCells).toBe(8);
    expect(preview.summary.previewCellCount).toBe(8);
    expect(preview.summary.isPreviewLimited).toBe(false);
    expect(preview.summary.previewStride).toBe(1);
    expect(preview.summary.warning).toBeNull();
    expect(preview.cells).toHaveLength(8);
  });

  it('preserves totalCells accuracy even when preview is limited', () => {
    const preview = buildGridPreview(
      [
        [
          [0, 0],
          [100, 0],
          [100, 100],
          [0, 100],
          [0, 0],
        ],
      ],
      1,
      { maxPreviewCells: 100 },
    );

    expect(preview.summary.totalCells).toBe(10000);
    expect(preview.summary.previewCellCount).toBeLessThanOrEqual(100);
    expect(preview.summary.isPreviewLimited).toBe(true);
    expect(preview.cells).toHaveLength(preview.summary.previewCellCount);
  });
});
