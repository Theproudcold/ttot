import { create } from 'zustand';

import type { GridAggregationMode, GridCell, GridSummary } from '@/shared/types/grid';
import type { MetricTransform } from '@/shared/geo/crs';

/**
 * 网格状态：包含单元大小、旋转角度、聚合模式、网格单元列表及汇总信息。
 */
type GridOrigin = {
  metricOrigin: [number, number];
  metricCellSize: number;
  metricTransform: MetricTransform | null;
};

type GridState = {
  cellSize: number;
  rotation: number;
  aggregationMode: GridAggregationMode;
  summary: GridSummary | null;
  cells: GridCell[];
  origin: GridOrigin | null;
  setCellSize: (cellSize: number) => void;
  setRotation: (rotation: number) => void;
  setAggregationMode: (mode: GridAggregationMode) => void;
  setSummary: (summary: GridSummary | null) => void;
  setPreview: (cells: GridCell[], summary: GridSummary | null, origin?: GridOrigin | null) => void;
  reset: () => void;
};

/**
 * 网格初始状态：默认 1m 单元大小、无旋转、均值聚合。
 */
const INITIAL_STATE = {
  cellSize: 1,
  rotation: 0,
  aggregationMode: 'mean' as GridAggregationMode,
  summary: null as GridSummary | null,
  cells: [] as GridCell[],
  origin: null as GridOrigin | null,
};

/**
 * 网格全局状态管理（Zustand）。
 */
export const useGridStore = create<GridState>((set) => ({
  ...INITIAL_STATE,
  setCellSize: (cellSize) => set({ cellSize }),
  setRotation: (rotation) => set({ rotation }),
  setAggregationMode: (aggregationMode) => set({ aggregationMode }),
  setSummary: (summary) => set({ summary }),
  setPreview: (cells, summary, origin) => set({ cells, summary, origin: origin ?? null }),
  reset: () => set(INITIAL_STATE),
}));
