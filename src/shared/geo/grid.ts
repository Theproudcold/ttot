import type { MetricTransform } from '@/shared/geo/crs';
import { getFenceSummary, isPointInFence } from '@/shared/geo/fence';
import type { FencePosition, FenceRings } from '@/shared/types/fence';
import type { GridAggregationResult, GridCell, GridPreview } from '@/shared/types/grid';

/**
 * 构建网格预览的可选参数。
 * 支持向后兼容的旧版多参数调用方式。
 */
type GridPreviewOptions = {
  metricTransform?: MetricTransform;
  aggregation?: GridAggregationResult;
  rotationDeg?: number;
  maxPreviewCells?: number;
};

/**
 * 将点绕指定中心旋转指定弧度。
 */
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

/**
 * 构建一个轴对齐的矩形多边形环（闭合）。
 */
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

/**
 * 基于围栏多边形和网格参数生成网格预览。
 * 支持度量变换、旋转角度以及可选的聚合结果注入。
 */
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

  const maxPreviewCells = options.maxPreviewCells;
  const needsLimit = maxPreviewCells != null && cells.length > maxPreviewCells;
  const previewCells = needsLimit
    ? cells.filter((_, index) => index % Math.ceil(cells.length / maxPreviewCells) === 0)
    : cells;

  return {
    cells: previewCells,
    summary: {
      cellSize,
      rotation: rotationDeg,
      rows,
      cols,
      totalCells: estimatedTotalCells,
      previewCellCount: previewCells.length,
      isPreviewLimited: needsLimit,
      previewStride: needsLimit ? Math.ceil(cells.length / maxPreviewCells) : 1,
      warning: needsLimit
        ? `当前网格数量约 ${estimatedTotalCells.toLocaleString()} 个，地图仅预览采样网格（约 ${previewCells.length.toLocaleString()} 个），导出结果仍完整。`
        : null,
    },
  };
}

/**
 * 利用度量变换将轴对齐的度量矩形转换为地理坐标多边形。
 */
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

/**
 * 先旋转度量矩形，再通过度量变换得到地理坐标多边形。
 * 用于生成带旋转角度的网格单元。
 */
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

/**
 * 计算围栏在指定旋转后的度量空间中的轴对齐边界框。
 */
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

/**
 * 计算围栏在度量空间中的轴对齐边界框。
 */
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

/**
 * 解析向后兼容的多参数输入，统一返回 GridPreviewOptions。
 */
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

/**
 * 从多参数输入中提取 MetricTransform，若未提供则生成恒等变换。
 */
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

/**
 * 创建恒等度量变换（地理坐标与度量坐标 1:1 映射）。
 * 默认以围栏边界框作为度量范围。
 */
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

/**
 * 类型守卫：判断值是否为网格聚合结果。
 */
function isGridAggregationResult(value: unknown): value is GridAggregationResult {
  return Boolean(value && typeof value === 'object' && 'cellsById' in value);
}

/**
 * 类型守卫：判断值是否为度量变换对象。
 */
function isMetricTransform(value: unknown): value is MetricTransform {
  return Boolean(value && typeof value === 'object' && 'toMetric' in value && 'fromMetric' in value);
}
