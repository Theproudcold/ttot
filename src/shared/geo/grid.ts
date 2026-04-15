import type { MetricTransform } from '@/shared/geo/crs';
import { getFenceSummary, isPointInFence } from '@/shared/geo/fence';
import type { FencePosition, FenceRings } from '@/shared/types/fence';
import type { GridAggregationResult, GridCell, GridPreview } from '@/shared/types/grid';

type GridPreviewOptions = {
  metricTransform?: MetricTransform;
  aggregation?: GridAggregationResult;
  rotationDeg?: number;
};

function rotatePoint(
  point: [number, number],
  center: [number, number],
  angleRad: number,
): [number, number] {
  if (angleRad === 0) {
    return point;
  }

  const [x, y] = point;
  const [cx, cy] = center;
  const dx = x - cx;
  const dy = y - cy;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);

  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

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
  thirdArg?: GridPreviewOptions | GridAggregationResult | MetricTransform,
  fourthArg?: GridAggregationResult | MetricTransform,
): GridPreview {
  if (cellSize <= 0) {
    throw new Error('cell size must be greater than 0');
  }

  const options = resolveOptions(thirdArg, fourthArg);
  const aggregation = options.aggregation;
  const metricTransform = options.metricTransform ?? createIdentityMetricTransform(rings);
  const rotationDeg = options.rotationDeg ?? 0;
  const rotationRad = (rotationDeg * Math.PI) / 180;

  const [minX, minY, maxX, maxY] = getMetricBounds(rings, metricTransform);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const center: [number, number] = [centerX, centerY];

  let gridMinX = minX;
  let gridMinY = minY;
  let gridMaxX = maxX;
  let gridMaxY = maxY;

  if (rotationRad !== 0) {
    const rotatedBounds = getRotatedMetricBounds(rings, metricTransform, center, -rotationRad);
    gridMinX = rotatedBounds[0];
    gridMinY = rotatedBounds[1];
    gridMaxX = rotatedBounds[2];
    gridMaxY = rotatedBounds[3];
  }

  const cols = Math.ceil((gridMaxX - gridMinX) / cellSize);
  const rows = Math.ceil((gridMaxY - gridMinY) / cellSize);
  const estimatedTotalCells = rows * cols;
  const cells: GridCell[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const cellMinX = gridMinX + col * cellSize;
      const cellMinY = gridMinY + row * cellSize;
      const cellMaxX = Math.min(cellMinX + cellSize, gridMaxX);
      const cellMaxY = Math.min(cellMinY + cellSize, gridMaxY);

      let cellCenter = [(cellMinX + cellMaxX) / 2, (cellMinY + cellMaxY) / 2] as [number, number];

      if (rotationRad !== 0) {
        cellCenter = rotatePoint(cellCenter, center, rotationRad);
      }

      const centerGeo = metricTransform.fromMetric(cellCenter);

      if (!isPointInFence(centerGeo, rings)) {
        continue;
      }

      const cellId = `r${row}-c${col}`;
      let polygon: FenceRings;

      if (rotationRad === 0) {
        polygon = buildCellPolygonFromMetric(metricTransform, cellMinX, cellMinY, cellMaxX, cellMaxY);
      } else {
        polygon = buildRotatedCellPolygonFromMetric(
          metricTransform,
          cellMinX,
          cellMinY,
          cellMaxX,
          cellMaxY,
          center,
          rotationRad,
        );
      }

      cells.push({
        id: cellId,
        row,
        col,
        center: centerGeo,
        polygon,
        aggregation: aggregation?.cellsById[cellId],
      });
    }
  }

  return {
    cells,
    summary: {
      cellSize,
      rotation: rotationDeg,
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

function buildRotatedCellPolygonFromMetric(
  metricTransform: MetricTransform,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  center: [number, number],
  rotationRad: number,
): FenceRings {
  const bottomLeft = rotatePoint([minX, minY], center, rotationRad);
  const bottomRight = rotatePoint([maxX, minY], center, rotationRad);
  const topRight = rotatePoint([maxX, maxY], center, rotationRad);
  const topLeft = rotatePoint([minX, maxY], center, rotationRad);

  return [
    [
      metricTransform.fromMetric(bottomLeft),
      metricTransform.fromMetric(bottomRight),
      metricTransform.fromMetric(topRight),
      metricTransform.fromMetric(topLeft),
      metricTransform.fromMetric(bottomLeft),
    ],
  ];
}

function getRotatedMetricBounds(
  rings: FenceRings,
  metricTransform: MetricTransform,
  center: [number, number],
  rotationRad: number,
): [number, number, number, number] {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const ring of rings) {
    for (const point of ring) {
      const [x, y] = metricTransform.toMetric(point);
      const [rx, ry] = rotatePoint([x, y], center, rotationRad);
      minX = Math.min(minX, rx);
      minY = Math.min(minY, ry);
      maxX = Math.max(maxX, rx);
      maxY = Math.max(maxY, ry);
    }
  }

  return [minX, minY, maxX, maxY];
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

function resolveOptions(
  thirdArg?: GridPreviewOptions | GridAggregationResult | MetricTransform,
  fourthArg?: GridAggregationResult | MetricTransform,
): GridPreviewOptions {
  if (thirdArg && typeof thirdArg === 'object' && !isGridAggregationResult(thirdArg) && !isMetricTransform(thirdArg)) {
    return thirdArg as GridPreviewOptions;
  }

  return {
    metricTransform: isMetricTransform(thirdArg) ? thirdArg : isMetricTransform(fourthArg) ? fourthArg : undefined,
    aggregation: isGridAggregationResult(thirdArg) ? thirdArg : isGridAggregationResult(fourthArg) ? fourthArg : undefined,
  };
}

function resolveMetricTransform(
  rings: FenceRings,
  thirdArg?: GridPreviewOptions | GridAggregationResult | MetricTransform,
  fourthArg?: GridAggregationResult | MetricTransform,
): MetricTransform {
  const options = resolveOptions(thirdArg, fourthArg);

  if (options.metricTransform) {
    return options.metricTransform;
  }

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

function isGridAggregationResult(value: unknown): value is GridAggregationResult {
  return Boolean(value && typeof value === 'object' && 'cellsById' in value);
}

function isMetricTransform(value: unknown): value is MetricTransform {
  return Boolean(value && typeof value === 'object' && 'toMetric' in value && 'fromMetric' in value);
}
