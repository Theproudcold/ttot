import type { MetricTransform } from '@/shared/geo/crs';
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
  thirdArg?: GridAggregationResult | MetricTransform,
  fourthArg?: GridAggregationResult | MetricTransform,
): GridPreview {
  if (cellSize <= 0) {
    throw new Error('cell size must be greater than 0');
  }

  const aggregation = resolveAggregation(thirdArg, fourthArg);
  const metricTransform = resolveMetricTransform(rings, thirdArg, fourthArg);
  const [minX, minY, maxX, maxY] = getMetricBounds(rings, metricTransform);
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
      const center = metricTransform.fromMetric([(cellMinX + cellMaxX) / 2, (cellMinY + cellMaxY) / 2]);

      if (!isPointInFence(center, rings)) {
        continue;
      }

      const cellId = `r${row}-c${col}`;

      cells.push({
        id: cellId,
        row,
        col,
        center,
        polygon: buildCellPolygonFromMetric(metricTransform, cellMinX, cellMinY, cellMaxX, cellMaxY),
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

function buildCellPolygonFromMetric(
  metricTransform: MetricTransform,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): FenceRings {
  const bottomLeft = metricTransform.fromMetric([minX, minY]);
  const bottomRight = metricTransform.fromMetric([maxX, minY]);
  const topRight = metricTransform.fromMetric([maxX, maxY]);
  const topLeft = metricTransform.fromMetric([minX, maxY]);

  return [[bottomLeft, bottomRight, topRight, topLeft, bottomLeft]];
}

function getMetricBounds(rings: FenceRings, metricTransform: MetricTransform): [number, number, number, number] {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const ring of rings) {
    for (const point of ring) {
      const [x, y] = metricTransform.toMetric(point);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  return [minX, minY, maxX, maxY];
}

function resolveAggregation(
  thirdArg?: GridAggregationResult | MetricTransform,
  fourthArg?: GridAggregationResult | MetricTransform,
): GridAggregationResult | undefined {
  if (isGridAggregationResult(thirdArg)) {
    return thirdArg;
  }

  if (isGridAggregationResult(fourthArg)) {
    return fourthArg;
  }

  return undefined;
}

function resolveMetricTransform(
  rings: FenceRings,
  thirdArg?: GridAggregationResult | MetricTransform,
  fourthArg?: GridAggregationResult | MetricTransform,
): MetricTransform {
  if (isMetricTransform(thirdArg)) {
    return thirdArg;
  }

  if (isMetricTransform(fourthArg)) {
    return fourthArg;
  }

  return createIdentityMetricTransform(rings);
}

function createIdentityMetricTransform(rings: FenceRings): MetricTransform {
  const { bbox } = getFenceSummary(rings);
  const [minX, minY, maxX, maxY] = bbox;

  return {
    coordinateDisplayMode: 'projected',
    metricExtent: {
      minX,
      minY,
      maxX,
      maxY,
    },
    metricWidth: Math.max(0, maxX - minX),
    metricHeight: Math.max(0, maxY - minY),
    toMetric: ([x, y]) => [x, y],
    fromMetric: ([x, y]) => [x, y],
  };
}

function isGridAggregationResult(value: GridAggregationResult | MetricTransform | undefined): value is GridAggregationResult {
  return Boolean(value && 'cellsById' in value);
}

function isMetricTransform(value: GridAggregationResult | MetricTransform | undefined): value is MetricTransform {
  return Boolean(value && 'toMetric' in value && 'fromMetric' in value);
}
