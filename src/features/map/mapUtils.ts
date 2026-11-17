import { useMapUiStore } from '@/features/map/mapUiStore';
import { findRasterClassificationMatch } from '@/shared/geo/rasterClassification';
import { getFenceSummary } from '@/shared/geo/fence';
import { isPointInFence } from '@/shared/geo/fence';
import type { FenceRings } from '@/shared/types/fence';
import type { GridCell, GridRenderSettings } from '@/shared/types/grid';
import type { RasterClassificationLayer, RasterMetadata } from '@/shared/types/raster';

import { useRasterStore } from './rasterStore';

/**
 * 延迟刷新地图尺寸的目标对象类型。
 * 用于 scheduleMapResizeFrame 中统一处理 OpenLayers Map 或自定义对象。
 */
export type DeferredMapResizeTarget = {
  getTarget: () => unknown;
  updateSize: () => void;
  renderSync: () => void;
};

/**
 * 基于 requestAnimationFrame 的值调度器类型。
 * 可将高频值更新合并到单一动画帧中执行，降低渲染压力。
 */
export type FrameValueScheduler<T> = {
  schedule: (value: T) => void;
  cancel: () => void;
};

/**
 * 网格单元命中测试器类型。
 * 输入地理坐标，返回命中的网格单元或 null。
 */
export type GridCellHitTester = (coordinate: [number, number]) => GridCell | null;

/**
 * 判断 innerBbox 是否完全包含在 outerBbox 内。
 * 用于快速校验围栏边界框是否落在影像范围内。
 */
export function isBboxInside(
  innerBbox: [number, number, number, number],
  outerBbox: [number, number, number, number],
): boolean {
  return (
    innerBbox[0] >= outerBbox[0] &&
    innerBbox[1] >= outerBbox[1] &&
    innerBbox[2] <= outerBbox[2] &&
    innerBbox[3] <= outerBbox[3]
  );
}

/**
 * 将数值限制在 [0, max] 范围内。
 * 常用于像素行列号的越界保护。
 */
export function clampIndex(value: number, max: number): number {
  return Math.min(Math.max(0, value), max);
}

/**
 * 根据地理坐标和影像元数据，计算该坐标对应的像素行列号。
 * 返回 { row, col }，行列号会被 clampIndex 限制在影像有效范围内。
 */
export function getPixelPosition(
  coordinate: [number, number],
  metadata: RasterMetadata,
): { row: number; col: number } {
  const [minX, minY, maxX, maxY] = metadata.boundingBox;
  const col = clampIndex(
    Math.floor(((coordinate[0] - minX) / (maxX - minX || Number.EPSILON)) * metadata.width),
    metadata.width - 1,
  );
  const row = clampIndex(
    Math.floor(((maxY - coordinate[1]) / (maxY - minY || Number.EPSILON)) * metadata.height),
    metadata.height - 1,
  );

  return { row, col };
}

/**
 * 根据地理坐标从预览数据中提取各波段的采样值。
 * 如果所有波段值均为 NaN，则返回 null。
 */
export function getPreviewSampleValues(
  coordinate: [number, number],
  metadata: RasterMetadata,
  preview: NonNullable<ReturnType<typeof useRasterStore.getState>['preview']>,
): number[] | null {
  if (!preview.sampleData || !preview.sampleBandCount) {
    return null;
  }

  const [minX, minY, maxX, maxY] = metadata.boundingBox;
  const col = clampIndex(
    Math.floor(((coordinate[0] - minX) / (maxX - minX || Number.EPSILON)) * preview.width),
    preview.width - 1,
  );
  const row = clampIndex(
    Math.floor(((maxY - coordinate[1]) / (maxY - minY || Number.EPSILON)) * preview.height),
    preview.height - 1,
  );
  const offset = (row * preview.width + col) * preview.sampleBandCount;
  const values = [];

  for (let bandIndex = 0; bandIndex < preview.sampleBandCount; bandIndex += 1) {
    values.push(preview.sampleData[offset + bandIndex] ?? Number.NaN);
  }

  return values.every((value) => Number.isNaN(value)) ? null : values;
}

/**
 * 遍历所有网格单元，使用多边形包含测试查找坐标所在的网格单元。
 * 作为 createGridCellHitTester 的纯多边形回退方案。
 */
export function scanGridCellAtCoordinate(coordinate: [number, number], cells: GridCell[]): GridCell | null {
  for (const cell of cells) {
    if (isPointInFence(coordinate, cell.polygon)) {
      return cell;
    }
  }

  return null;
}

/**
 * 将十六进制颜色字符串和透明度转换为 rgba() CSS 字符串。
 */
export function hexToRgba(hex: string, alpha: number): string {
  const sanitized = hex.replace('#', '');
  const r = Number.parseInt(sanitized.substring(0, 2), 16);
  const g = Number.parseInt(sanitized.substring(2, 4), 16);
  const b = Number.parseInt(sanitized.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * 创建一个恒等度量变换（无投影转换）。
 * 当影像没有提供投影转换时，坐标本身即视为度量坐标。
 */
export function createIdentityMetricTransform(fenceRings: FenceRings) {
  const { bbox } = getFenceSummary(fenceRings);
  const [minX, minY, maxX, maxY] = bbox;

  return {
    coordinateDisplayMode: 'projected' as const,
    metricExtent: {
      minX,
      minY,
      maxX,
      maxY,
    },
    metricWidth: Math.max(0, maxX - minX),
    metricHeight: Math.max(0, maxY - minY),
    toMetric: ([x, y]: [number, number]) => [x, y] as [number, number],
    fromMetric: ([x, y]: [number, number]) => [x, y] as [number, number],
  };
}

/**
 * 计算围栏在度量坐标系下的边界框 [minX, minY, maxX, maxY]。
 * 如果提供了 metricTransform，会先对所有顶点执行 toMetric 转换。
 */
export function getFenceMetricBounds(
  fenceRings: FenceRings,
  metricTransform?: RasterMetadata['metricTransform'] | null,
): [number, number, number, number] {
  const transform = metricTransform ?? createIdentityMetricTransform(fenceRings);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const ring of fenceRings) {
    for (const point of ring) {
      const [x, y] = transform.toMetric(point);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  return [minX, minY, maxX, maxY];
}

/**
 * 创建网格单元命中测试器。
 * 策略：先用基于网格行列号的索引快速定位候选单元（索引加速），
 * 若未命中再回退到完整的多边形遍历（polygon fallback），保证精度。
 */
export function createGridCellHitTester(input: {
  cells: GridCell[];
  fenceRings: FenceRings;
  cellSize: number;
  metricTransform?: RasterMetadata['metricTransform'] | null;
}): GridCellHitTester {
  const { cells, fenceRings, cellSize, metricTransform } = input;
  const indexedCells = new globalThis.Map(cells.map((cell) => [cell.id, cell]));
  const [minX, minY, maxX, maxY] = getFenceMetricBounds(fenceRings, metricTransform);
  const transform = metricTransform ?? createIdentityMetricTransform(fenceRings);
  const safeCellSize = cellSize || Number.EPSILON;

  return (coordinate) => {
    const [metricX, metricY] = transform.toMetric(coordinate);

    if (metricX >= minX && metricX <= maxX && metricY >= minY && metricY <= maxY) {
      const row = Math.floor((metricY - minY) / safeCellSize);
      const col = Math.floor((metricX - minX) / safeCellSize);
      const indexedCell = indexedCells.get(`r${row}-c${col}`);

      if (indexedCell && isPointInFence(coordinate, indexedCell.polygon)) {
        return indexedCell;
      }
    }

    return scanGridCellAtCoordinate(coordinate, cells);
  };
}

/**
 * 安全地请求动画帧，在非浏览器环境中回退到 setTimeout。
 */
export function scheduleAnimationFrame(callback: FrameRequestCallback): number {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(callback);
  }

  // 非浏览器环境（如 jsdom/Node）回退到定时器。运行期返回的是数字句柄，
  // 但 Node 的 setTimeout 在类型上返回 Timeout 对象，因此这里显式归一为 number。
  return globalThis.setTimeout(() => callback(Date.now()), 16) as unknown as number;
}

/**
 * 安全地取消动画帧，在非浏览器环境中回退到 clearTimeout。
 */
export function cancelScheduledAnimationFrame(frameId: number) {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(frameId);
    return;
  }

  globalThis.clearTimeout(frameId);
}

/**
 * 创建基于动画帧的值合并调度器。
 * 在高频输入场景下，可将多次 schedule 合并为一次 callback 调用，
 * 常用于 pointermove 等高频事件的处理。
 */
export function createAnimationFrameValueScheduler<T>(
  callback: (value: T) => void,
  scheduler: typeof requestAnimationFrame = scheduleAnimationFrame,
  canceler: typeof cancelAnimationFrame = cancelScheduledAnimationFrame,
): FrameValueScheduler<T> {
  let frameId: number | null = null;
  let latestValue: T | undefined;

  return {
    schedule(value) {
      latestValue = value;

      if (frameId !== null) {
        return;
      }

      frameId = scheduler(() => {
        frameId = null;
        if (latestValue === undefined) {
          return;
        }

        const nextValue = latestValue;
        latestValue = undefined;
        callback(nextValue);
      });
    },
    cancel() {
      if (frameId !== null) {
        canceler(frameId);
        frameId = null;
      }

      latestValue = undefined;
    },
  };
}

/**
 * 根据当前网格渲染设置和分类图层，计算指定网格单元的填充色和边框色。
 * 若启用分类颜色且单元有聚合输出值，则返回匹配的分类颜色；
 * 否则返回用户自定义颜色或透明色。
 */
export function getGridCellStyleColors(
  cell: GridCell,
  visibleClassificationLayer: (RasterClassificationLayer & { visible: boolean }) | null,
  gridRenderSettings: GridRenderSettings,
): { strokeColor: string; fillColor: string } {
  if (!gridRenderSettings.useClassificationColors) {
    return {
      strokeColor: hexToRgba(gridRenderSettings.strokeColor, gridRenderSettings.strokeOpacity),
      fillColor: hexToRgba(gridRenderSettings.fillColor, gridRenderSettings.fillOpacity),
    };
  }

  const outputValue = cell.aggregation?.outputValue;
  if (outputValue === null || outputValue === undefined || !Number.isFinite(outputValue)) {
    return {
      strokeColor: hexToRgba(gridRenderSettings.strokeColor, gridRenderSettings.strokeOpacity),
      fillColor: 'rgba(0, 0, 0, 0)',
    };
  }

  return {
    strokeColor: hexToRgba(gridRenderSettings.strokeColor, gridRenderSettings.strokeOpacity),
    fillColor:
      findRasterClassificationMatch(
        outputValue,
        visibleClassificationLayer ?? useMapUiStore.getState().classificationLayers[0],
      )?.color ?? 'rgba(17, 17, 17, 0.18)',
  };
}

/**
 * 判断当前预览是否可按主波段执行"单波段分类着色"。
 *
 * 不能直接用 sampleBandCount：rules 模式导出的文件带有追加的处方波段，
 * 它的样本数是 2，但参与分类的数据波段只有 1 个（classificationBandCount）。
 */
export function canClassifySingleBand(
  preview: { sampleBandCount?: number; classificationBandCount?: number } | null | undefined,
): boolean {
  if (!preview) {
    return false;
  }

  return (preview.classificationBandCount ?? preview.sampleBandCount ?? 0) === 1;
}

/**
 * 从采样值数组中提取主波段值（第一个值）。
 * 若值为 undefined、非有限数或等于 noDataValue，则返回 null。
 */
export function getPrimarySampleValue(
  sampleValues: number[] | null,
  noDataValue?: number | null,
): number | null {
  const primaryValue = sampleValues?.[0];
  if (primaryValue === undefined || !Number.isFinite(primaryValue)) {
    return null;
  }

  if (noDataValue !== null && noDataValue !== undefined && primaryValue === noDataValue) {
    return null;
  }

  return primaryValue;
}

/**
 * 从分类图层列表中获取当前可见的分类图层。
 * 优先返回 visibleClassificationLayerId 指定的图层（若可见），
 * 否则返回列表中第一个 visible 为 true 的图层。
 */
export function getVisibleClassificationLayer(
  classificationLayers: Array<RasterClassificationLayer & { visible: boolean }>,
  visibleClassificationLayerId: string | null,
): (RasterClassificationLayer & { visible: boolean }) | null {
  if (visibleClassificationLayerId) {
    const preferredLayer = classificationLayers.find((layer) => layer.id === visibleClassificationLayerId);
    if (preferredLayer?.visible) {
      return preferredLayer;
    }
  }

  return classificationLayers.find((layer) => layer.visible) ?? null;
}
