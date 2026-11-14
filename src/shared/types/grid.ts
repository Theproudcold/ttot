import type { MetricTransform } from '@/shared/geo/crs';
import type { FenceRings } from '@/shared/types/fence';

export type GridAggregationMode = 'mean' | 'max' | 'min';

export type GridCellAggregation = {
  cellId: string;
  row: number;
  col: number;
  pixelCount: number;
  validPixelCount: number;
  sumValue: number;
  meanValue: number | null;
  minValue: number | null;
  maxValue: number | null;
  outputValue: number | null;
};

export type GridCell = {
  id: string;
  row: number;
  col: number;
  center: [number, number];
  polygon: FenceRings;
  aggregation?: GridCellAggregation;
};

export type GridSummary = {
  cellSize: number;
  rotation: number;
  rows: number;
  cols: number;
  totalCells: number;
  previewCellCount: number;
  isPreviewLimited: boolean;
  previewStride: number;
  warning: string | null;
};

export type GridPreview = {
  cells: GridCell[];
  summary: GridSummary;
  metricOrigin: [number, number];
  metricCellSize: number;
  /**
   * 生成该预览时实际使用的度量变换。
   * 调用方（网格命中查找、聚合注入）必须复用同一个变换，否则网格定位会与预览不一致。
   */
  metricTransform?: MetricTransform | null;
};

export type GridAggregationResult = {
  cellsById: Record<string, GridCellAggregation>;
};

export type GridRenderSettings = {
  useClassificationColors: boolean;
  fillColor: string;
  fillOpacity: number;
  strokeColor: string;
  strokeOpacity: number;
  strokeWidth: number;
};
