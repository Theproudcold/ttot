import { getFenceSummary, isPointInFence } from '@/shared/geo/fence';
import type { FencePosition, FenceRings } from '@/shared/types/fence';
import type { GridAggregationResult, GridCell, GridPreview } from '@/shared/types/grid';

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

export function buildGridPreview(
  rings: FenceRings,
  cellSize: number,
  aggregation?: GridAggregationResult,
): GridPreview {
  if (cellSize <= 0) {
    throw new Error('cell size must be greater than 0');
  }

  const { bbox } = getFenceSummary(rings);
  const [minX, minY, maxX, maxY] = bbox;
  const cols = Math.ceil((maxX - minX) / cellSize);
  const rows = Math.ceil((maxY - minY) / cellSize);
  const estimatedTotalCells = rows * cols;
  const cells: GridCell[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const cellMinX = minX + col * cellSize;
      const cellMinY = minY + row * cellSize;
      const cellMaxX = Math.min(cellMinX + cellSize, maxX);
      const cellMaxY = Math.min(cellMinY + cellSize, maxY);
      const center: FencePosition = [(cellMinX + cellMaxX) / 2, (cellMinY + cellMaxY) / 2];

      if (!isPointInFence(center, rings)) {
        continue;
      }

      const cellId = `r${row}-c${col}`;

      cells.push({
        id: cellId,
        row,
        col,
        center,
        polygon: buildCellPolygon(cellMinX, cellMinY, cellMaxX, cellMaxY),
        aggregation: aggregation?.cellsById[cellId],
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
      isPreviewLimited: false,
      previewStride: 1,
      warning: null,
    },
  };
}
