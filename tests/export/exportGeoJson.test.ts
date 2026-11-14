import { describe, expect, it } from 'vitest';

import { createFenceGeoJson, createGridGeoJson } from '@/features/export/exportGeoJson';
import type { FenceFeature } from '@/shared/types/fence';
import type { GridCell, GridSummary } from '@/shared/types/grid';
import type { RasterRuleClassificationLayer } from '@/shared/types/raster';

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
  rotation: 0,
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

function withAggregation(cells: GridCell[], outputValue: number): GridCell[] {
  return cells.map((cell) => ({
    ...cell,
    aggregation: {
      cellId: cell.id,
      row: cell.row,
      col: cell.col,
      pixelCount: 4,
      validPixelCount: 4,
      sumValue: outputValue * 4,
      meanValue: outputValue,
      minValue: outputValue,
      maxValue: outputValue,
      outputValue,
    },
  }));
}

// gridSummary.cellSize = 5 → 单元格面积 25 m²
const perCellRulesLayer: RasterRuleClassificationLayer = {
  id: 'per-cell',
  label: '单格用量',
  mode: 'rules',
  noDataColor: '#00000000',
  gradientStops: [],
  rules: [{ min: 0, max: null, color: '#226622', label: '高值', applicationRate: 30 }],
};

const perAreaRulesLayer: RasterRuleClassificationLayer = {
  ...perCellRulesLayer,
  id: 'per-area',
  label: '单位面积用量',
  rules: [
    {
      min: 0,
      max: null,
      color: '#226622',
      label: '高值',
      applicationRate: 4,
      applicationRateBasis: 'per-area',
      applicationRateUnit: 'per-hectare',
    },
  ],
};

describe('createGridGeoJson with classification rules', () => {
  it('keeps the historical per-cell amount unchanged', () => {
    const result = createGridGeoJson(withAggregation(gridCells, 0.5), gridSummary, perCellRulesLayer);

    expect(result.features[0].properties.fertilizerAmount).toBe(30);
    // 按格计量时原始速率与结果相同，无需额外记录
    expect(result.features[0].properties.applicationRate).toBeUndefined();
  });

  it('derives the per-cell amount for per-area rules and records the basis', () => {
    // 4 kg/ha × 25 m² ÷ 10000 m² = 0.01
    const result = createGridGeoJson(withAggregation(gridCells, 0.5), gridSummary, perAreaRulesLayer);
    const properties = result.features[0].properties;

    expect(properties.fertilizerAmount).toBe(0.01);
    expect(properties.applicationRate).toBe(4);
    expect(properties.applicationRateUnit).toBe('per-hectare');
    expect(properties.cellAreaM2).toBe(25);
  });

  it('omits fertilizerAmount when no rule matches the aggregated value', () => {
    const noMatchLayer: RasterRuleClassificationLayer = {
      ...perCellRulesLayer,
      rules: [{ min: 10, max: 20, color: '#226622', label: '区间外', applicationRate: 30 }],
    };
    const result = createGridGeoJson(withAggregation(gridCells, 0.5), gridSummary, noMatchLayer);

    expect(result.features[0].properties.aggregationValue).toBe(0.5);
    expect(result.features[0].properties.fertilizerAmount).toBeUndefined();
  });
});
