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
 * 聚合输入参数。
 */
type GridAggregationInput = {
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
};

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
 * 网格索引：`included` 以 `row * cols + col` 为下标，1 表示该单元被围栏命中。
 */
type GridIndex = {
  gridMinX: number;
  gridMinY: number;
  gridMaxX: number;
  gridMaxY: number;
  cols: number;
  rows: number;
  included: Uint8Array;
};

/**
 * 构建网格几何信息与命中标记。
 * 命中规则：单元格中心点（旋转后）落在围栏内部。
 *
 * 为什么用 `Uint8Array` 代替 `Set<string>`：聚合热路径上每个像元都要做一次归属查询，
 * 字符串键需要拼接与哈希，而数值下标只是一次数组读取。
 */
function buildGridIndex(
  fenceRings: FenceRings,
  gridCellWidth: number,
  gridCellHeight: number,
  metricTransform: MetricTransform,
  rotationDeg = 0,
): GridIndex {
  const metrics = getGridMetrics(fenceRings, gridCellWidth, gridCellHeight, metricTransform, rotationDeg);
  const included = new Uint8Array(metrics.cols * metrics.rows);
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
        included[row * metrics.cols + col] = 1;
      }
    }
  }

  return { ...metrics, included };
}

/**
 * 单元格累加器。全部使用类型化数组，按下标累加，避免每像元创建对象或字符串键。
 */
type CellAccumulator = {
  sumValue: Float64Array;
  validPixelCount: Uint32Array;
  pixelCount: Uint32Array;
  minValue: Float64Array;
  maxValue: Float64Array;
};

function createCellAccumulator(cellCount: number): CellAccumulator {
  const minValue = new Float64Array(cellCount);
  const maxValue = new Float64Array(cellCount);
  minValue.fill(Number.POSITIVE_INFINITY);
  maxValue.fill(Number.NEGATIVE_INFINITY);

  return {
    sumValue: new Float64Array(cellCount),
    validPixelCount: new Uint32Array(cellCount),
    pixelCount: new Uint32Array(cellCount),
    minValue,
    maxValue,
  };
}

/**
 * 把累加器结果整理成对外契约结构。
 *
 * `hitCellIds` 记录单元格首次命中像元的顺序，保证返回对象的键顺序与逐像元累加实现一致。
 * 只有真正命中过像元的单元格才会出现在结果里。
 */
function materializeAggregation(
  index: GridIndex,
  accumulator: CellAccumulator,
  hitCellIds: readonly number[],
  mode: GridAggregationMode,
): GridAggregationResult {
  const cellsById: Record<string, GridCellAggregation> = {};

  for (let hit = 0; hit < hitCellIds.length; hit += 1) {
    const id = hitCellIds[hit];
    const row = Math.floor(id / index.cols);
    const col = id % index.cols;
    const pixelCount = accumulator.pixelCount[id];
    const validPixelCount = accumulator.validPixelCount[id];
    const cellId = `r${row}-c${col}`;

    if (validPixelCount === 0) {
      cellsById[cellId] = {
        cellId,
        row,
        col,
        pixelCount,
        validPixelCount,
        sumValue: 0,
        meanValue: null,
        minValue: null,
        maxValue: null,
        outputValue: null,
      };
      continue;
    }

    const sumValue = accumulator.sumValue[id];
    const meanValue = sumValue / validPixelCount;
    const minValue = accumulator.minValue[id];
    const maxValue = accumulator.maxValue[id];

    let outputValue = meanValue;
    if (mode === 'max') {
      outputValue = maxValue;
    } else if (mode === 'min') {
      outputValue = minValue;
    }

    cellsById[cellId] = {
      cellId,
      row,
      col,
      pixelCount,
      validPixelCount,
      sumValue,
      meanValue,
      minValue,
      maxValue,
      outputValue,
    };
  }

  return { cellsById };
}

/**
 * 把一行中连续像素累加进同一个单元格。
 * 先读入局部变量、循环结束后一次性写回，避免每像元访问类型化数组。
 */
function accumulateSpan(
  accumulator: CellAccumulator,
  hitCellIds: number[],
  cellIndex: number,
  band: SupportedRasterArray,
  start: number,
  length: number,
  noDataValue: number | null,
): void {
  let pixelCount = accumulator.pixelCount[cellIndex];
  if (pixelCount === 0) {
    hitCellIds.push(cellIndex);
  }

  let validPixelCount = accumulator.validPixelCount[cellIndex];
  let sumValue = accumulator.sumValue[cellIndex];
  let minValue = accumulator.minValue[cellIndex];
  let maxValue = accumulator.maxValue[cellIndex];
  const end = start + length;

  for (let index = start; index < end; index += 1) {
    pixelCount += 1;
    const value = band[index];

    if ((noDataValue !== null && value === noDataValue) || !Number.isFinite(value)) {
      continue;
    }

    validPixelCount += 1;
    sumValue += value;
    if (value < minValue) {
      minValue = value;
    }
    if (value > maxValue) {
      maxValue = value;
    }
  }

  accumulator.pixelCount[cellIndex] = pixelCount;
  accumulator.validPixelCount[cellIndex] = validPixelCount;
  accumulator.sumValue[cellIndex] = sumValue;
  accumulator.minValue[cellIndex] = minValue;
  accumulator.maxValue[cellIndex] = maxValue;
}

/**
 * 行列方向的度量坐标查找表。
 *
 * 为什么可以拆成两个一维表：当前所有度量变换（恒等、地理坐标局部等距）都是可分的，
 * 即 metricX 只依赖经度/东向坐标、metricY 只依赖纬度/北向坐标。
 * 这样每像元只需读表，不再调用变换函数（那里每次都会新建数组）。
 * 若未来出现不可分的变换，探针会失败并退回逐像元调用变换的实现。
 */
type MetricAxes = {
  xByCol: Float64Array;
  yByRow: Float64Array;
};

function buildMetricAxes(
  metricTransform: MetricTransform,
  window: PixelWindow,
  width: number,
  height: number,
  origin: RasterOrigin,
  resolution: RasterResolution,
): MetricAxes | null {
  if (width <= 0 || height <= 0) {
    return null;
  }

  const [windowStartCol, windowStartRow] = window;
  const [originX, originY] = origin;
  const [resolutionX, resolutionY] = resolution;
  const xByCol = new Float64Array(width);
  const yByRow = new Float64Array(height);

  for (let col = 0; col < width; col += 1) {
    xByCol[col] = metricTransform.toMetric([originX + (windowStartCol + col + 0.5) * resolutionX, originY])[0];
  }

  for (let row = 0; row < height; row += 1) {
    yByRow[row] = metricTransform.toMetric([originX, originY + (windowStartRow + row + 0.5) * resolutionY])[1];
  }

  const probes: Array<[number, number]> = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
    [width >> 1, height >> 1],
  ];

  for (const [col, row] of probes) {
    const [metricX, metricY] = metricTransform.toMetric(
      getPixelCenter(windowStartCol + col, windowStartRow + row, origin, resolution),
    );

    if (metricX !== xByCol[col] || metricY !== yByRow[row]) {
      return null;
    }
  }

  return { xByCol, yByRow };
}

/**
 * 相邻且属于同一网格列的像素列区间。
 */
type ColSegment = {
  start: number;
  end: number;
  cellCol: number;
};

/**
 * 计算每一像素列所属的网格列号，网格范围之外为 -1。
 */
function buildColCellIndices(
  width: number,
  cols: number,
  gridMinX: number,
  gridCellWidth: number,
  xByCol: Float64Array,
): Int32Array {
  const cellIndices = new Int32Array(width);

  for (let col = 0; col < width; col += 1) {
    const cellCol = Math.floor((xByCol[col] - gridMinX) / gridCellWidth);
    cellIndices[col] = cellCol >= 0 && cellCol < cols ? cellCol : -1;
  }

  return cellIndices;
}

/**
 * 把网格列号相同的相邻像素列合并为区间。
 * 合并后内层循环不再需要逐像元做除法和归属判断，只保留取值与统计。
 */
function buildColSegments(colCellIndices: Int32Array): ColSegment[] {
  const segments: ColSegment[] = [];
  const width = colCellIndices.length;
  let col = 0;

  while (col < width) {
    const cellCol = colCellIndices[col];
    let end = col + 1;

    while (end < width && colCellIndices[end] === cellCol) {
      end += 1;
    }

    if (cellCol >= 0) {
      segments.push({ start: col, end, cellCol });
    }

    col = end;
  }

  return segments;
}

/**
 * 计算每一像素行所属的网格行号，网格范围之外为 -1。
 */
function buildRowCellIndices(
  height: number,
  rows: number,
  gridMinY: number,
  gridCellHeight: number,
  yByRow: Float64Array,
): Int32Array {
  const cellIndices = new Int32Array(height);

  for (let row = 0; row < height; row += 1) {
    const cellRow = Math.floor((yByRow[row] - gridMinY) / gridCellHeight);
    cellIndices[row] = cellRow >= 0 && cellRow < rows ? cellRow : -1;
  }

  return cellIndices;
}

/**
 * 聚合内核：按行推进，行内按像素列区间直接累加。
 */
type AggregationKernel = {
  height: number;
  accumulateRow: (row: number) => void;
  finish: () => GridAggregationResult;
};

/**
 * 构建聚合内核。
 *
 * 无旋转时走「列区间扫描」快路径：先按网格列把像素列切成区间，
 * 每行只做区间级累加，避免逐像元的度量计算、除法与命中判断。
 * 有旋转或度量变换不可分时退回逐像元路径，语义完全一致。
 */
function createAggregationKernel(input: GridAggregationInput): AggregationKernel {
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
  const index = buildGridIndex(fenceRings, gridCellWidth, gridCellHeight, resolvedMetricTransform, rotationDeg);
  const accumulator = createCellAccumulator(index.cols * index.rows);
  const hitCellIds: number[] = [];
  const rotationRad = (rotationDeg * Math.PI) / 180;
  const [windowStartCol, windowStartRow] = window;

  const finish = () => materializeAggregation(index, accumulator, hitCellIds, aggregationMode);

  const axes = buildMetricAxes(resolvedMetricTransform, window, width, height, origin, resolution);

  if (rotationRad === 0 && axes) {
    const colCellIndices = buildColCellIndices(width, index.cols, index.gridMinX, gridCellWidth, axes.xByCol);
    const segments = buildColSegments(colCellIndices);
    const rowCellIndices = buildRowCellIndices(height, index.rows, index.gridMinY, gridCellHeight, axes.yByRow);

    const accumulateRow = (row: number) => {
      const cellRow = rowCellIndices[row];
      if (cellRow < 0) {
        return;
      }

      const base = row * width;
      const rowOffset = cellRow * index.cols;

      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
        const segment = segments[segmentIndex];
        const cellIndex = rowOffset + segment.cellCol;

        if (index.included[cellIndex] !== 1) {
          continue;
        }

        accumulateSpan(
          accumulator,
          hitCellIds,
          cellIndex,
          band,
          base + segment.start,
          segment.end - segment.start,
          noDataValue,
        );
      }
    };

    return { height, accumulateRow, finish };
  }

  // 旋转或度量变换不可分：逐像元计算归属，但仍复用度量查找表避免每像元分配。
  let gridCenterX = 0;
  let gridCenterY = 0;
  if (rotationRad !== 0) {
    const [minX, minY, maxX, maxY] = getMetricBounds(fenceRings, resolvedMetricTransform);
    gridCenterX = (minX + maxX) / 2;
    gridCenterY = (minY + maxY) / 2;
  }

  const cosRotation = Math.cos(-rotationRad);
  const sinRotation = Math.sin(-rotationRad);

  const accumulateRow = (row: number) => {
    const base = row * width;
    const rowMetricY = axes ? axes.yByRow[row] : 0;

    for (let col = 0; col < width; col += 1) {
      let metricX: number;
      let metricY: number;

      if (axes) {
        metricX = axes.xByCol[col];
        metricY = rowMetricY;
      } else {
        const center = resolvedMetricTransform.toMetric(
          getPixelCenter(windowStartCol + col, windowStartRow + row, origin, resolution),
        );
        metricX = center[0];
        metricY = center[1];
      }

      let gridX = metricX;
      let gridY = metricY;

      if (rotationRad !== 0) {
        const deltaX = metricX - gridCenterX;
        const deltaY = metricY - gridCenterY;
        gridX = gridCenterX + deltaX * cosRotation - deltaY * sinRotation;
        gridY = gridCenterY + deltaX * sinRotation + deltaY * cosRotation;
      }

      const cellCol = Math.floor((gridX - index.gridMinX) / gridCellWidth);
      const cellRow = Math.floor((gridY - index.gridMinY) / gridCellHeight);

      if (cellCol < 0 || cellCol >= index.cols || cellRow < 0 || cellRow >= index.rows) {
        continue;
      }

      const cellIndex = cellRow * index.cols + cellCol;
      if (index.included[cellIndex] !== 1) {
        continue;
      }

      accumulateSpan(accumulator, hitCellIds, cellIndex, band, base + col, 1, noDataValue);
    }
  };

  return { height, accumulateRow, finish };
}

/**
 * 同步方式对栅格窗口进行网格聚合。
 * 遍历窗口内所有像素，将位于围栏内的像素按网格单元汇总，最后计算各单元的统计值。
 */
export function aggregateGridCellsFromRasterWindow(input: GridAggregationInput): GridAggregationResult {
  const kernel = createAggregationKernel(input);

  for (let row = 0; row < kernel.height; row += 1) {
    kernel.accumulateRow(row);
  }

  return kernel.finish();
}

/**
 * 异步方式对栅格窗口进行网格聚合。
 * 与同步版本逻辑一致，但会按指定行数分块让出主线程，避免大数据量阻塞 UI。
 */
export async function aggregateGridCellsFromRasterWindowAsync(
  input: GridAggregationInput,
  options: GridAggregationAsyncOptions = {},
): Promise<GridAggregationResult> {
  const kernel = createAggregationKernel(input);
  const rowsPerChunk = resolveRowsPerChunk(options.rowsPerChunk);
  const yieldControl = options.yieldControl ?? defaultYieldControl;

  for (let row = 0; row < kernel.height; row += 1) {
    if (row > 0 && row % rowsPerChunk === 0) {
      // Yield between row chunks so large rasters do not monopolize the main thread.
      await yieldControl();
    }

    kernel.accumulateRow(row);
  }

  return kernel.finish();
}

/**
 * 将网格聚合结果应用到多波段栅格数据上。
 * 每个像素值被替换为其所在网格单元的聚合输出值；不在任何网格单元内的像素设为 noDataValue。
 * 返回改写后的波段数组及被掩膜（置为 noData）的像素数量。
 *
 * `outputType` 缺省为 `float64`（保持历史契约与高精度中间值）。
 * 导出路径已知产物最终是 Float32，可直接用 `float32` 生成，
 * 省掉每波段整幅的 Float64 缓冲（8 字节/像元 → 4 字节/像元）。
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
  outputType?: 'float32' | 'float64';
}): { bands: SupportedRasterArray[]; maskedPixelCount: number } {
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
  const index = buildGridIndex(fenceRings, gridCellWidth, gridCellHeight, resolvedMetricTransform, rotationDeg);
  const rotationRad = (rotationDeg * Math.PI) / 180;
  const [windowStartCol, windowStartRow] = window;
  const axes = buildMetricAxes(resolvedMetricTransform, window, width, height, origin, resolution);

  const outputType = input.outputType ?? 'float64';
  // Float32 输出时哨兵值会先被舍入，比较必须用舍入后的值，否则掩膜计数会漏
  const storedNoDataValue = outputType === 'float32' ? Math.fround(noDataValue) : noDataValue;

  let gridCenterX = 0;
  let gridCenterY = 0;
  if (rotationRad !== 0) {
    const [minX, minY, maxX, maxY] = getMetricBounds(fenceRings, resolvedMetricTransform);
    gridCenterX = (minX + maxX) / 2;
    gridCenterY = (minY + maxY) / 2;
  }

  const cosRotation = Math.cos(-rotationRad);
  const sinRotation = Math.sin(-rotationRad);

  // 无旋转时先算出列区间，避免每个波段都对每个像元重算归属
  const scanline = rotationRad === 0 && axes ? {
    segments: buildColSegments(buildColCellIndices(width, index.cols, index.gridMinX, gridCellWidth, axes.xByCol)),
    rowCellIndices: buildRowCellIndices(height, index.rows, index.gridMinY, gridCellHeight, axes.yByRow),
  } : null;

  const rewrittenBands = bands.map((band) => {
    const nextBand: Float64Array | Float32Array =
      outputType === 'float32' ? new Float32Array(band.length) : new Float64Array(band.length);
    nextBand.fill(storedNoDataValue);

    for (let row = 0; row < height; row += 1) {
      const base = row * width;

      if (scanline) {
        const cellRow = scanline.rowCellIndices[row];
        if (cellRow < 0) {
          continue;
        }

        const rowOffset = cellRow * index.cols;

        for (let segmentIndex = 0; segmentIndex < scanline.segments.length; segmentIndex += 1) {
          const segment = scanline.segments[segmentIndex];
          const cellIndex = rowOffset + segment.cellCol;

          if (index.included[cellIndex] !== 1) {
            continue;
          }

          const cellId = `r${cellRow}-c${segment.cellCol}`;
          const outputValue = aggregation.cellsById[cellId]?.outputValue ?? null;
          nextBand.fill(
            outputValue === null ? storedNoDataValue : outputValue,
            base + segment.start,
            base + segment.end,
          );
        }

        continue;
      }

      for (let col = 0; col < width; col += 1) {
        let metricX: number;
        let metricY: number;

        if (axes) {
          metricX = axes.xByCol[col];
          metricY = axes.yByRow[row];
        } else {
          const center = resolvedMetricTransform.toMetric(
            getPixelCenter(windowStartCol + col, windowStartRow + row, origin, resolution),
          );
          metricX = center[0];
          metricY = center[1];
        }

        let gridX = metricX;
        let gridY = metricY;

        if (rotationRad !== 0) {
          const deltaX = metricX - gridCenterX;
          const deltaY = metricY - gridCenterY;
          gridX = gridCenterX + deltaX * cosRotation - deltaY * sinRotation;
          gridY = gridCenterY + deltaX * sinRotation + deltaY * cosRotation;
        }

        const cellCol = Math.floor((gridX - index.gridMinX) / gridCellWidth);
        const cellRow = Math.floor((gridY - index.gridMinY) / gridCellHeight);

        if (cellCol < 0 || cellCol >= index.cols || cellRow < 0 || cellRow >= index.rows) {
          continue;
        }

        const cellIndex = cellRow * index.cols + cellCol;
        if (index.included[cellIndex] !== 1) {
          continue;
        }

        const cellId = `r${cellRow}-c${cellCol}`;
        const outputValue = aggregation.cellsById[cellId]?.outputValue ?? null;
        nextBand[base + col] = outputValue === null ? storedNoDataValue : outputValue;
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
        rewrittenPrimaryBand[pixelIndex] === storedNoDataValue &&
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
