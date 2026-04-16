import type { MetricTransform } from '@/shared/geo/crs';
import { getFenceSummary, isPointInFence } from '@/shared/geo/fence';
import type { FencePosition, FenceRings } from '@/shared/types/fence';
import type { GridAggregationMode, GridAggregationResult, GridCellAggregation } from '@/shared/types/grid';
import type { RasterOrigin, RasterResolution } from '@/shared/types/raster';

/**
 * 支持的栅格数据数组类型。
 */
type SupportedRasterArray =
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Float32Array
  | Float64Array;

/**
 * 像素窗口：[起始列, 起始行, 宽度, 高度]。
 */
type PixelWindow = [number, number, number, number];

/**
 * 异步聚合的可选参数。
 */
type GridAggregationAsyncOptions = {
  rowsPerChunk?: number;
  yieldControl?: () => Promise<void>;
};

/**
 * 校验网格单元宽高是否合法（必须大于 0 且为有限数）。
 */
function assertValidGridCellSize(gridCellWidth: number, gridCellHeight: number): void {
  if (!Number.isFinite(gridCellWidth) || gridCellWidth <= 0 || !Number.isFinite(gridCellHeight) || gridCellHeight <= 0) {
    throw new Error('cell size must be greater than 0');
  }
}

/**
 * 解析每次分块处理的行数，若非法则默认返回 128。
 */
function resolveRowsPerChunk(rowsPerChunk?: number): number {
  const safeRowsPerChunk = rowsPerChunk ?? 0;

  if (!Number.isFinite(safeRowsPerChunk) || safeRowsPerChunk <= 0) {
    return 128;
  }

  return Math.max(1, Math.floor(safeRowsPerChunk));
}

/**
 * 默认的让出控制权实现：使用 setTimeout 将执行权交还给事件循环。
 */
function defaultYieldControl(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });
}

/**
 * 根据行列号计算像素中心点的地理坐标。
 */
function getPixelCenter(
  col: number,
  row: number,
  origin: RasterOrigin,
  resolution: RasterResolution,
): FencePosition {
  const [originX, originY] = origin;
  const [resolutionX, resolutionY] = resolution;

  return [originX + (col + 0.5) * resolutionX, originY + (row + 0.5) * resolutionY];
}

/**
 * 构建单个网格单元的初始聚合数据结构。
 */
function buildCellAggregation(cellId: string, row: number, col: number): GridCellAggregation {
  return {
    cellId,
    row,
    col,
    pixelCount: 0,
    validPixelCount: 0,
    sumValue: 0,
    meanValue: null,
    minValue: Number.POSITIVE_INFINITY,
    maxValue: Number.NEGATIVE_INFINITY,
    outputValue: null,
  };
}

/**
 * 创建恒等度量变换（地理坐标与度量坐标 1:1 映射）。
 */
function createIdentityMetricTransform(fenceRings: FenceRings): MetricTransform {
  const { bbox } = getFenceSummary(fenceRings);
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
 * 解析度量变换对象，若未提供则基于围栏创建恒等变换。
 */
function resolveMetricTransform(fenceRings: FenceRings, metricTransform?: MetricTransform): MetricTransform {
  return metricTransform ?? createIdentityMetricTransform(fenceRings);
}

/**
 * 计算围栏在度量空间中的轴对齐边界框 [minX, minY, maxX, maxY]。
 */
function getMetricBounds(fenceRings: FenceRings, metricTransform: MetricTransform): [number, number, number, number] {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const ring of fenceRings) {
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
 * 计算围栏在指定旋转后的度量空间中的轴对齐边界框。
 */
function getRotatedMetricBounds(
  fenceRings: FenceRings,
  metricTransform: MetricTransform,
  center: [number, number],
  rotationRad: number,
): [number, number, number, number] {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const ring of fenceRings) {
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
 * 计算网格在度量空间中的范围、行列数等几何信息。
 * 若指定旋转角度，则先计算旋转后的外接矩形再划分网格。
 */
function getGridMetrics(
  fenceRings: FenceRings,
  gridCellWidth: number,
  gridCellHeight: number,
  metricTransform: MetricTransform,
  rotationDeg = 0,
) {
  assertValidGridCellSize(gridCellWidth, gridCellHeight);
  const [minX, minY, maxX, maxY] = getMetricBounds(fenceRings, metricTransform);

  let gridMinX = minX;
  let gridMinY = minY;
  let gridMaxX = maxX;
  let gridMaxY = maxY;

  const rotationRad = (rotationDeg * Math.PI) / 180;
  if (rotationRad !== 0) {
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const rotatedBounds = getRotatedMetricBounds(fenceRings, metricTransform, [centerX, centerY], -rotationRad);
    gridMinX = rotatedBounds[0];
    gridMinY = rotatedBounds[1];
    gridMaxX = rotatedBounds[2];
    gridMaxY = rotatedBounds[3];
  }

  return {
    gridMinX,
    gridMinY,
    gridMaxX,
    gridMaxY,
    cols: Math.ceil((gridMaxX - gridMinX) / gridCellWidth),
    rows: Math.ceil((gridMaxY - gridMinY) / gridCellHeight),
  };
}

/**
 * 根据网格行列号和几何参数计算单个单元格的度量边界。
 */
function getCellBounds(input: {
  row: number;
  col: number;
  gridMinX: number;
  gridMinY: number;
  gridMaxX: number;
  gridMaxY: number;
  gridCellWidth: number;
  gridCellHeight: number;
}): { minX: number; minY: number; maxX: number; maxY: number } {
  const { row, col, gridMinX, gridMinY, gridMaxX, gridMaxY, gridCellWidth, gridCellHeight } = input;
  const minX = gridMinX + col * gridCellWidth;
  const maxX = Math.min(minX + gridCellWidth, gridMaxX);
  const minY = gridMinY + row * gridCellHeight;
  const maxY = Math.min(minY + gridCellHeight, gridMaxY);

  return { minX, minY, maxX, maxY };
}

/**
 * 遍历网格所有单元格，仅保留中心点位于围栏内部的单元格 ID。
 * 返回包含的单元格集合及网格几何信息。
 */
function buildIncludedCellIds(
  fenceRings: FenceRings,
  gridCellWidth: number,
  gridCellHeight: number,
  metricTransform: MetricTransform,
  rotationDeg = 0,
): {
  includedCellIds: Set<string>;
  gridMinX: number;
  gridMinY: number;
  gridMaxX: number;
  gridMaxY: number;
  cols: number;
  rows: number;
} {
  const metrics = getGridMetrics(fenceRings, gridCellWidth, gridCellHeight, metricTransform, rotationDeg);
  const includedCellIds = new Set<string>();
  const rotationRad = (rotationDeg * Math.PI) / 180;

  let center: [number, number] | null = null;
  if (rotationRad !== 0) {
    const [minX, minY, maxX, maxY] = getMetricBounds(fenceRings, metricTransform);
    center = [(minX + maxX) / 2, (minY + maxY) / 2];
  }

  for (let row = 0; row < metrics.rows; row += 1) {
    for (let col = 0; col < metrics.cols; col += 1) {
      const { minX, minY, maxX, maxY } = getCellBounds({
        row,
        col,
        gridMinX: metrics.gridMinX,
        gridMinY: metrics.gridMinY,
        gridMaxX: metrics.gridMaxX,
        gridMaxY: metrics.gridMaxY,
        gridCellWidth,
        gridCellHeight,
      });
      let cellCenter: [number, number] = [(minX + maxX) / 2, (minY + maxY) / 2];

      if (rotationRad !== 0 && center) {
        cellCenter = rotatePoint(cellCenter, center, rotationRad);
      }

      const centerGeo = metricTransform.fromMetric(cellCenter);

      if (isPointInFence(centerGeo, fenceRings)) {
        includedCellIds.add(`r${row}-c${col}`);
      }
    }
  }

  return {
    includedCellIds,
    ...metrics,
  };
}

/**
 * 根据像素中心点坐标反查其所属的网格单元 ID。
 * 若像素不在网格范围内或对应单元格不在围栏内，则返回 null。
 */
function getCellIdForPixel(input: {
  center: FencePosition;
  gridMinX: number;
  gridMinY: number;
  cols: number;
  rows: number;
  gridCellWidth: number;
  gridCellHeight: number;
  includedCellIds: Set<string>;
  rotationDeg?: number;
  gridCenter?: [number, number];
}): { cellId: string; row: number; col: number } | null {
  const { center, gridMinX, gridMinY, cols, rows, gridCellWidth, gridCellHeight, includedCellIds, rotationDeg = 0, gridCenter } = input;
  let [centerX, centerY] = center;
  const rotationRad = (rotationDeg * Math.PI) / 180;

  if (rotationRad !== 0 && gridCenter) {
    [centerX, centerY] = rotatePoint([centerX, centerY], gridCenter, -rotationRad);
  }

  const col = Math.floor((centerX - gridMinX) / gridCellWidth);
  const row = Math.floor((centerY - gridMinY) / gridCellHeight);

  if (col < 0 || col >= cols || row < 0 || row >= rows) {
    return null;
  }

  const cellId = `r${row}-c${col}`;
  if (!includedCellIds.has(cellId)) {
    return null;
  }

  return { cellId, row, col };
}

/**
 * 对聚合结果进行最终计算：求均值、最小值、最大值，并根据聚合模式确定输出值。
 */
function finalizeAggregation(
  cellsById: Record<string, GridCellAggregation>,
  mode: GridAggregationMode = 'mean',
): GridAggregationResult {
  for (const cell of Object.values(cellsById)) {
    if (cell.validPixelCount === 0) {
      cell.meanValue = null;
      cell.minValue = null;
      cell.maxValue = null;
      cell.outputValue = null;
      continue;
    }

    cell.meanValue = cell.sumValue / cell.validPixelCount;
    cell.minValue = cell.minValue ?? null;
    cell.maxValue = cell.maxValue ?? null;

    if (mode === 'max') {
      cell.outputValue = cell.maxValue;
    } else if (mode === 'min') {
      cell.outputValue = cell.minValue;
    } else {
      cell.outputValue = cell.meanValue;
    }
  }

  return { cellsById };
}

/**
 * 同步方式对栅格窗口进行网格聚合。
 * 遍历窗口内所有像素，将位于围栏内的像素按网格单元汇总，最后计算各单元的统计值。
 */
export function aggregateGridCellsFromRasterWindow(input: {
  window: PixelWindow;
  width: number;
  height: number;
  origin: RasterOrigin;
  resolution: RasterResolution;
  fenceRings: FenceRings;
  gridCellWidth: number;
  gridCellHeight: number;
  band: SupportedRasterArray;
  noDataValue: number | null;
  metricTransform?: MetricTransform;
  aggregationMode?: GridAggregationMode;
  rotationDeg?: number;
}): GridAggregationResult {
  const {
    window,
    width,
    height,
    origin,
    resolution,
    fenceRings,
    gridCellWidth,
    gridCellHeight,
    band,
    noDataValue,
    metricTransform,
    aggregationMode = 'mean',
    rotationDeg = 0,
  } = input;
  assertValidGridCellSize(gridCellWidth, gridCellHeight);
  const resolvedMetricTransform = resolveMetricTransform(fenceRings, metricTransform);
  const [windowStartCol, windowStartRow] = window;
  const { includedCellIds, gridMinX, gridMinY, cols, rows } = buildIncludedCellIds(
    fenceRings,
    gridCellWidth,
    gridCellHeight,
    resolvedMetricTransform,
    rotationDeg,
  );

  let gridCenter: [number, number] | undefined;
  const rotationRad = (rotationDeg * Math.PI) / 180;
  if (rotationRad !== 0) {
    const [minX, minY, maxX, maxY] = getMetricBounds(fenceRings, resolvedMetricTransform);
    gridCenter = [(minX + maxX) / 2, (minY + maxY) / 2];
  }

  const cellsById: Record<string, GridCellAggregation> = {};

  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const pixelIndex = row * width + col;
      const center = resolvedMetricTransform.toMetric(
        getPixelCenter(windowStartCol + col, windowStartRow + row, origin, resolution),
      );
      const cellMatch = getCellIdForPixel({
        center,
        gridMinX,
        gridMinY,
        cols,
        rows,
        gridCellWidth,
        gridCellHeight,
        includedCellIds,
        rotationDeg,
        gridCenter,
      });

      if (!cellMatch) {
        continue;
      }

      const cell =
        cellsById[cellMatch.cellId] ??
        (cellsById[cellMatch.cellId] = buildCellAggregation(
          cellMatch.cellId,
          cellMatch.row,
          cellMatch.col,
        ));
      cell.pixelCount += 1;

      const value = band[pixelIndex];
      if ((noDataValue !== null && value === noDataValue) || !Number.isFinite(value)) {
        continue;
      }

      cell.validPixelCount += 1;
      cell.sumValue += value;
      cell.minValue = Math.min(cell.minValue ?? Number.POSITIVE_INFINITY, value);
      cell.maxValue = Math.max(cell.maxValue ?? Number.NEGATIVE_INFINITY, value);
    }
  }

  return finalizeAggregation(cellsById, aggregationMode);
}

/**
 * 异步方式对栅格窗口进行网格聚合。
 * 与同步版本逻辑一致，但会按指定行数分块让出主线程，避免大数据量阻塞 UI。
 */
export async function aggregateGridCellsFromRasterWindowAsync(
  input: {
    window: PixelWindow;
    width: number;
    height: number;
    origin: RasterOrigin;
    resolution: RasterResolution;
    fenceRings: FenceRings;
    gridCellWidth: number;
    gridCellHeight: number;
    band: SupportedRasterArray;
    noDataValue: number | null;
    metricTransform?: MetricTransform;
    aggregationMode?: GridAggregationMode;
    rotationDeg?: number;
  },
  options: GridAggregationAsyncOptions = {},
): Promise<GridAggregationResult> {
  const {
    window,
    width,
    height,
    origin,
    resolution,
    fenceRings,
    gridCellWidth,
    gridCellHeight,
    band,
    noDataValue,
    metricTransform,
    aggregationMode = 'mean',
    rotationDeg = 0,
  } = input;
  assertValidGridCellSize(gridCellWidth, gridCellHeight);
  const resolvedMetricTransform = resolveMetricTransform(fenceRings, metricTransform);
  const [windowStartCol, windowStartRow] = window;
  const { includedCellIds, gridMinX, gridMinY, cols, rows } = buildIncludedCellIds(
    fenceRings,
    gridCellWidth,
    gridCellHeight,
    resolvedMetricTransform,
    rotationDeg,
  );

  let gridCenter: [number, number] | undefined;
  const rotationRad = (rotationDeg * Math.PI) / 180;
  if (rotationRad !== 0) {
    const [minX, minY, maxX, maxY] = getMetricBounds(fenceRings, resolvedMetricTransform);
    gridCenter = [(minX + maxX) / 2, (minY + maxY) / 2];
  }

  // 快速围栏边界框预过滤，跳过明显在围栏外的像元
  const [fenceMinX, fenceMinY, fenceMaxX, fenceMaxY] = getMetricBounds(fenceRings, resolvedMetricTransform);

  const cellsById: Record<string, GridCellAggregation> = {};
  const rowsPerChunk = resolveRowsPerChunk(options.rowsPerChunk);
  const yieldControl = options.yieldControl ?? defaultYieldControl;

  for (let row = 0; row < height; row += 1) {
    if (row > 0 && row % rowsPerChunk === 0) {
      // Yield between row chunks so large rasters do not monopolize the main thread.
      await yieldControl();
    }

    for (let col = 0; col < width; col += 1) {
      const pixelIndex = row * width + col;
      const center = resolvedMetricTransform.toMetric(
        getPixelCenter(windowStartCol + col, windowStartRow + row, origin, resolution),
      );
      const [px, py] = center;
      if (px < fenceMinX || px > fenceMaxX || py < fenceMinY || py > fenceMaxY) {
        continue;
      }
      const cellMatch = getCellIdForPixel({
        center,
        gridMinX,
        gridMinY,
        cols,
        rows,
        gridCellWidth,
        gridCellHeight,
        includedCellIds,
        rotationDeg,
        gridCenter,
      });

      if (!cellMatch) {
        continue;
      }

      const cell =
        cellsById[cellMatch.cellId] ??
        (cellsById[cellMatch.cellId] = buildCellAggregation(
          cellMatch.cellId,
          cellMatch.row,
          cellMatch.col,
        ));
      cell.pixelCount += 1;

      const value = band[pixelIndex];
      if ((noDataValue !== null && value === noDataValue) || !Number.isFinite(value)) {
        continue;
      }

      cell.validPixelCount += 1;
      cell.sumValue += value;
      cell.minValue = Math.min(cell.minValue ?? Number.POSITIVE_INFINITY, value);
      cell.maxValue = Math.max(cell.maxValue ?? Number.NEGATIVE_INFINITY, value);
    }
  }

  return finalizeAggregation(cellsById, aggregationMode);
}

/**
 * 将网格聚合结果应用到多波段栅格数据上。
 * 每个像素值被替换为其所在网格单元的聚合输出值；不在任何网格单元内的像素设为 noDataValue。
 * 返回改写后的波段数组及被掩膜（置为 noData）的像素数量。
 */
export function applyGridAggregationToBands(input: {
  bands: SupportedRasterArray[];
  aggregation: GridAggregationResult;
  width: number;
  height: number;
  window: PixelWindow;
  origin: RasterOrigin;
  resolution: RasterResolution;
  fenceRings: FenceRings;
  gridCellWidth: number;
  gridCellHeight: number;
  noDataValue: number;
  metricTransform?: MetricTransform;
  rotationDeg?: number;
}): { bands: Float64Array[]; maskedPixelCount: number } {
  const {
    bands,
    aggregation,
    width,
    height,
    window,
    origin,
    resolution,
    fenceRings,
    gridCellWidth,
    gridCellHeight,
    noDataValue,
    metricTransform,
    rotationDeg = 0,
  } = input;
  assertValidGridCellSize(gridCellWidth, gridCellHeight);
  const resolvedMetricTransform = resolveMetricTransform(fenceRings, metricTransform);
  const [windowStartCol, windowStartRow] = window;
  const { includedCellIds, gridMinX, gridMinY, cols, rows } = buildIncludedCellIds(
    fenceRings,
    gridCellWidth,
    gridCellHeight,
    resolvedMetricTransform,
    rotationDeg,
  );

  let gridCenter: [number, number] | undefined;
  const rotationRad = (rotationDeg * Math.PI) / 180;
  if (rotationRad !== 0) {
    const [minX, minY, maxX, maxY] = getMetricBounds(fenceRings, resolvedMetricTransform);
    gridCenter = [(minX + maxX) / 2, (minY + maxY) / 2];
  }

  const rewrittenBands = bands.map((band) => {
    const nextBand = new Float64Array(band.length);

    for (let row = 0; row < height; row += 1) {
      for (let col = 0; col < width; col += 1) {
        const pixelIndex = row * width + col;
        const center = resolvedMetricTransform.toMetric(
          getPixelCenter(windowStartCol + col, windowStartRow + row, origin, resolution),
        );
        const cellMatch = getCellIdForPixel({
          center,
          gridMinX,
          gridMinY,
          cols,
          rows,
          gridCellWidth,
          gridCellHeight,
          includedCellIds,
          rotationDeg,
          gridCenter,
        });
        const outputValue = cellMatch
          ? aggregation.cellsById[cellMatch.cellId]?.outputValue ?? null
          : null;

        nextBand[pixelIndex] = outputValue === null ? noDataValue : outputValue;
      }
    }

    return nextBand;
  });

  let maskedPixelCount = 0;
  const sourceBand = bands[0];
  const rewrittenPrimaryBand = rewrittenBands[0];

  if (sourceBand && rewrittenPrimaryBand) {
    for (let pixelIndex = 0; pixelIndex < rewrittenPrimaryBand.length; pixelIndex += 1) {
      if (
        rewrittenPrimaryBand[pixelIndex] === noDataValue &&
        sourceBand[pixelIndex] !== noDataValue
      ) {
        maskedPixelCount += 1;
      }
    }
  }

  return {
    bands: rewrittenBands,
    maskedPixelCount,
  };
}
