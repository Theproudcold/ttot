import { describe, expect, it } from 'vitest';

import { buildGridPreview } from '@/shared/geo/grid';
import type { FenceRings } from '@/shared/types/fence';

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

  it('degrades preview density when the estimated grid is too dense for realtime rendering', () => {
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
    expect(preview.summary.previewCellCount).toBeLessThan(preview.summary.totalCells);
    expect(preview.summary.isPreviewLimited).toBe(true);
    expect(preview.summary.previewStride).toBeGreaterThan(1);
    expect(preview.summary.warning).toContain('抽样预览');
    expect(preview.cells).toHaveLength(preview.summary.previewCellCount);
  });
});
