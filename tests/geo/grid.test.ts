import { describe, expect, it } from 'vitest';

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
});
