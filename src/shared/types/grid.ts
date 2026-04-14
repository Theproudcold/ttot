import type { FenceRings } from '@/shared/types/fence';

export type GridCellAggregation = {
  cellId: string;
  row: number;
  col: number;
  pixelCount: number;
  validPixelCount: number;
  sumValue: number;
  meanValue: number | null;
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
};

export type GridAggregationResult = {
  cellsById: Record<string, GridCellAggregation>;
};
