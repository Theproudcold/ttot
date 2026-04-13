import type { FenceRings } from '@/shared/types/fence';

export type GridCell = {
  id: string;
  row: number;
  col: number;
  center: [number, number];
  polygon: FenceRings;
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
