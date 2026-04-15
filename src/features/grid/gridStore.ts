import { create } from 'zustand';

import type { GridCell, GridSummary } from '@/shared/types/grid';

type GridState = {
  cellSize: number;
  summary: GridSummary | null;
  cells: GridCell[];
  setCellSize: (cellSize: number) => void;
  setSummary: (summary: GridSummary | null) => void;
  setPreview: (cells: GridCell[], summary: GridSummary | null) => void;
  reset: () => void;
};

const INITIAL_STATE = {
  cellSize: 1,
  summary: null as GridSummary | null,
  cells: [] as GridCell[],
};

export const useGridStore = create<GridState>((set) => ({
  ...INITIAL_STATE,
  setCellSize: (cellSize) => set({ cellSize }),
  setSummary: (summary) => set({ summary }),
  setPreview: (cells, summary) => set({ cells: [...cells], summary }),
  reset: () => set(INITIAL_STATE),
}));
