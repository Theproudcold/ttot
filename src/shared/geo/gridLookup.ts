import type { MetricTransform } from '@/shared/geo/crs';
import type { GridCell, GridPreview } from '@/shared/types/grid';

/**
 * 网格查找表结构，用于 O(1) 坐标到网格单元的映射。
 */
export type GridLookup = {
  metricOrigin: [number, number];
  metricCellSize: number;
  metricTransform: MetricTransform | null;
  cellsById: globalThis.Map<string, GridCell>;
};

/**
 * 基于 GridPreview 构建网格查找表。
 * 利用行列数学直接定位单元，无需遍历或空间索引。
 */
export function buildGridLookup(
  preview: GridPreview,
  metricTransform: MetricTransform | null,
): GridLookup {
  return {
    metricOrigin: preview.metricOrigin,
    metricCellSize: preview.metricCellSize,
    metricTransform,
    cellsById: new globalThis.Map(preview.cells.map((cell) => [cell.id, cell])),
  };
}

/**
 * 根据地理坐标从网格查找表中定位对应的网格单元。
 * 先将坐标转换为度量坐标，再通过行列号数学直接计算 cellId。
 * 复杂度 O(1)。
 */
export function findCellAtCoordinate(
  coordinate: [number, number],
  lookup: GridLookup | null,
): GridCell | null {
  if (!lookup) {
    return null;
  }

  const transform = lookup.metricTransform ?? {
    toMetric: ([x, y]: [number, number]) => [x, y] as [number, number],
  };

  const [metricX, metricY] = transform.toMetric(coordinate);
  const [originX, originY] = lookup.metricOrigin;
  const cellSize = lookup.metricCellSize || Number.EPSILON;

  const col = Math.floor((metricX - originX) / cellSize);
  const row = Math.floor((metricY - originY) / cellSize);
  const cellId = `r${row}-c${col}`;

  return lookup.cellsById.get(cellId) ?? null;
}
