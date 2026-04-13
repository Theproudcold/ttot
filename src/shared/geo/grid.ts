import { getFenceSummary, isPointInFence } from '@/shared/geo/fence';
import type { FencePosition, FenceRings } from '@/shared/types/fence';
import type { GridCell, GridPreview } from '@/shared/types/grid';

export const MAX_GRID_PREVIEW_CELLS = 10000;

function buildCellPolygon(minX: number, minY: number, maxX: number, maxY: number): FenceRings {
  return [
    [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
      [minX, minY],
    ],
  ];
}

export function buildGridPreview(rings: FenceRings, cellSize: number): GridPreview {
  if (cellSize <= 0) {
    throw new Error('cell size must be greater than 0');
  }

  const { bbox } = getFenceSummary(rings);
  const [minX, minY, maxX, maxY] = bbox;
  const cols = Math.ceil((maxX - minX) / cellSize);
  const rows = Math.ceil((maxY - minY) / cellSize);
  const estimatedTotalCells = rows * cols;
  const previewStride =
    estimatedTotalCells > MAX_GRID_PREVIEW_CELLS
      ? Math.ceil(Math.sqrt(estimatedTotalCells / MAX_GRID_PREVIEW_CELLS))
      : 1;
  const cells: GridCell[] = [];

  for (let row = 0; row < rows; row += previewStride) {
    for (let col = 0; col < cols; col += previewStride) {
      const cellMinX = minX + col * cellSize;
      const cellMinY = minY + row * cellSize;
      const cellMaxX = Math.min(cellMinX + cellSize, maxX);
      const cellMaxY = Math.min(cellMinY + cellSize, maxY);
      const center: FencePosition = [(cellMinX + cellMaxX) / 2, (cellMinY + cellMaxY) / 2];

      if (!isPointInFence(center, rings)) {
        continue;
      }

      cells.push({
        id: `r${row}-c${col}`,
        row,
        col,
        center,
        polygon: buildCellPolygon(cellMinX, cellMinY, cellMaxX, cellMaxY),
      });
    }
  }

  return {
    cells,
    summary: {
      cellSize,
      rows,
      cols,
      totalCells: estimatedTotalCells,
      previewCellCount: cells.length,
      isPreviewLimited: previewStride > 1,
      previewStride,
      warning:
        previewStride > 1
          ? `网格过密，当前按 ${previewStride}x${previewStride} 抽样预览。`
          : null,
    },
  };
}
