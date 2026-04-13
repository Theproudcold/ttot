import { describe, expect, it } from 'vitest';

import { createFenceGeoJson, createGridGeoJson } from '@/features/export/exportGeoJson';
import type { FenceFeature } from '@/shared/types/fence';
import type { GridCell, GridSummary } from '@/shared/types/grid';

const fence: FenceFeature = {
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [10, 0],
        [10, 20],
        [0, 20],
        [0, 0],
      ],
    ],
  },
  summary: {
    area: 200,
    bbox: [0, 0, 10, 20],
    vertexCount: 4,
  },
};

const gridSummary: GridSummary = {
  cellSize: 5,
  rows: 4,
  cols: 2,
  totalCells: 2,
  previewCellCount: 2,
  isPreviewLimited: false,
  previewStride: 1,
  warning: null,
};

const gridCells: GridCell[] = [
  {
    id: 'r0-c0',
    row: 0,
    col: 0,
    center: [2.5, 2.5],
    polygon: [
      [
        [0, 0],
        [5, 0],
        [5, 5],
        [0, 5],
        [0, 0],
      ],
    ],
  },
  {
    id: 'r0-c1',
    row: 0,
    col: 1,
    center: [7.5, 2.5],
    polygon: [
      [
        [5, 0],
        [10, 0],
        [10, 5],
        [5, 5],
        [5, 0],
      ],
    ],
  },
];

describe('createFenceGeoJson', () => {
  it('exports a fence feature collection with summary properties', () => {
    const result = createFenceGeoJson(fence);

    expect(result.type).toBe('FeatureCollection');
    expect(result.features).toHaveLength(1);
    expect(result.features[0].properties).toEqual({
      area: 200,
      bbox: [0, 0, 10, 20],
      vertexCount: 4,
    });
  });
});

describe('createGridGeoJson', () => {
  it('exports grid cells with identifiers and cell size', () => {
    const result = createGridGeoJson(gridCells, gridSummary);

    expect(result.type).toBe('FeatureCollection');
    expect(result.features).toHaveLength(2);
    expect(result.features[0].properties).toEqual({
      id: 'r0-c0',
      row: 0,
      col: 0,
      centerX: 2.5,
      centerY: 2.5,
      cellSize: 5,
    });
  });
});
