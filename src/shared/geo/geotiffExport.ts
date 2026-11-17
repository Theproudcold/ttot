import type { MetricTransform } from '@/shared/geo/crs';
import { readFenceWindowWithCache } from '@/shared/geo/fenceWindow';
import {
  aggregateGridCellsFromRasterWindow,
  aggregateGridCellsFromRasterWindowAsync,
  applyGridAggregationToBands,
} from '@/shared/geo/gridAggregation';
import { buildRasterSourceKey, openRasterSession } from '@/shared/geo/raster';
import type { FenceRings } from '@/shared/types/fence';
import type { GridAggregationMode, GridAggregationResult } from '@/shared/types/grid';
import type {
  PixelWindow,
  RasterOrigin,
  RasterResolution,
  SupportedRasterArray,
} from '@/shared/types/raster';

export { getPixelWindowFromFenceBoundingBox } from '@/shared/geo/rasterWindow';
export type { PixelWindow, SupportedRasterArray } from '@/shared/types/raster';

export type GeoTiffFenceWindowData = {
  window: PixelWindow;
  width: number;
  height: number;
  bands: SupportedRasterArray[];
  origin: RasterOrigin;
  resolution: RasterResolution;
  sourceNoDataValue: number | null;
  bitsPerSample: number[];
  sampleFormat: number[];
  samplesPerPixel: number;
  fileDirectory: Record<string, unknown>;
};

function hasValueInBands(bands: SupportedRasterArray[], target: number): boolean {
  return bands.some((band) => {
    for (const value of band) {
      if (value === target) {
        return true;
      }
    }

    return false;
  });
}

function getNoDataCandidates(sampleFormat: number, bitsPerSample: number): number[] {
  if (sampleFormat === 3) {
    if (bitsPerSample === 32) {
      return [-3.4028234663852886e38, 3.4028234663852886e38];
    }

    return [-Number.MAX_VALUE, Number.MAX_VALUE];
  }

  if (sampleFormat === 2) {
    const max = 2 ** (bitsPerSample - 1) - 1;
    const min = -(2 ** (bitsPerSample - 1));
    return [min, max];
  }

  const max = 2 ** bitsPerSample - 1;
  return [max, 0];
}

export async function readGeoTiffFenceWindow(input: {
  file: File;
  fenceRings: FenceRings;
  samples?: number[];
}): Promise<GeoTiffFenceWindowData> {
  const { file, fenceRings, samples } = input;
  const sourceKey = buildRasterSourceKey(file);
  const image = await openRasterSession(file, { cacheKey: sourceKey }).getImage();
  const sampleIndexes =
    samples && samples.length > 0
      ? samples
      : Array.from({ length: image.getSamplesPerPixel() }, (_, index) => index);

  // 像元部分走共享窗口缓存（同一围栏在网格聚合里已经解码过就不再解码）；
  // 位深/样本格式等元信息直接从已解析的影像对象读取，不涉及解码。
  const windowData = await readFenceWindowWithCache({
    source: file,
    sourceKey,
    fenceRings,
    samples: sampleIndexes,
    image,
  });

  return {
    ...windowData,
    bitsPerSample: sampleIndexes.map((index) => image.getBitsPerSample(index)),
    sampleFormat: sampleIndexes.map((index) => image.getSampleFormat(index)),
    samplesPerPixel: sampleIndexes.length,
    fileDirectory: (image.getFileDirectory?.() ?? {}) as Record<string, unknown>,
  };
}

export function buildGridAggregationFromFenceWindow(input: {
  bands: SupportedRasterArray[];
  window: PixelWindow;
  width: number;
  height: number;
  origin: RasterOrigin;
  resolution: RasterResolution;
  fenceRings: FenceRings;
  gridCellWidth: number;
  gridCellHeight: number;
  sourceNoDataValue: number | null;
  metricTransform?: MetricTransform;
  aggregationMode?: GridAggregationMode;
  rotationDeg?: number;
}): GridAggregationResult {
  const {
    bands,
    window,
    width,
    height,
    origin,
    resolution,
    fenceRings,
    gridCellWidth,
    gridCellHeight,
    sourceNoDataValue,
    metricTransform,
    aggregationMode,
    rotationDeg,
  } =
    input;
  const primaryBand = bands[0];
  if (!primaryBand) {
    throw new Error('GeoTIFF 缺少主波段数据');
  }

  return aggregateGridCellsFromRasterWindow({
    window,
    width,
    height,
    origin,
    resolution,
    fenceRings,
    gridCellWidth,
    gridCellHeight,
    band: primaryBand,
    noDataValue: sourceNoDataValue,
    metricTransform,
    aggregationMode,
    rotationDeg,
  });
}

export async function buildGridAggregationFromFenceWindowAsync(
  input: {
    bands: SupportedRasterArray[];
    window: PixelWindow;
    width: number;
    height: number;
    origin: RasterOrigin;
    resolution: RasterResolution;
    fenceRings: FenceRings;
    gridCellWidth: number;
    gridCellHeight: number;
    sourceNoDataValue: number | null;
    metricTransform?: MetricTransform;
    aggregationMode?: GridAggregationMode;
    rotationDeg?: number;
  },
  options?: {
    rowsPerChunk?: number;
    yieldControl?: () => Promise<void>;
  },
): Promise<GridAggregationResult> {
  const {
    bands,
    window,
    width,
    height,
    origin,
    resolution,
    fenceRings,
    gridCellWidth,
    gridCellHeight,
    sourceNoDataValue,
    metricTransform,
    aggregationMode,
    rotationDeg,
  } = input;
  const primaryBand = bands[0];
  if (!primaryBand) {
    throw new Error('GeoTIFF 缺少主波段数据');
  }

  return await aggregateGridCellsFromRasterWindowAsync(
    {
      window,
      width,
      height,
      origin,
      resolution,
      fenceRings,
      gridCellWidth,
      gridCellHeight,
      band: primaryBand,
      noDataValue: sourceNoDataValue,
      metricTransform,
      aggregationMode,
      rotationDeg,
    },
    options,
  );
}

export function applyGridAggregationToFenceWindowBands(input: {
  bands: SupportedRasterArray[];
  window: PixelWindow;
  width: number;
  height: number;
  origin: RasterOrigin;
  resolution: RasterResolution;
  fenceRings: FenceRings;
  gridCellWidth: number;
  gridCellHeight: number;
  sourceNoDataValue: number | null;
  noDataValue?: number;
  /**
   * 在聚合结果可用后再决定 NoData 哨兵，提供时覆盖 noDataValue。
   * 用于避免哨兵与某个网格的聚合值碰撞（否则该网格在回读时会被当成 NoData 丢弃）。
   */
  resolveNoDataValue?: (aggregation: GridAggregationResult) => number;
  metricTransform?: MetricTransform;
  aggregationMode?: GridAggregationMode;
  rotationDeg?: number;
  /** 输出波段类型，缺省 float64；导出路径已知产物为 Float32，可传 float32 省一半缓冲 */
  outputType?: 'float32' | 'float64';
}): {
  aggregation: GridAggregationResult;
  bands: SupportedRasterArray[];
  maskedPixelCount: number;
  noDataValue: number;
} {
  const {
    bands,
    window,
    width,
    height,
    origin,
    resolution,
    fenceRings,
    gridCellWidth,
    gridCellHeight,
    sourceNoDataValue,
    noDataValue,
    resolveNoDataValue,
    metricTransform,
    aggregationMode,
    rotationDeg,
    outputType,
  } = input;

  if (bands.length === 0) {
    throw new Error('导出需要至少一个波段');
  }

  // 逐波段各自聚合：多波段影像的每个波段代表不同变量，
  // 用主波段的聚合值覆写其余波段等于伪造数据（README 明确承诺多波段可用）。
  // 代价是 N 倍聚合耗时，换来的是每个波段保留自己的网格均值。
  const aggregations = bands.map((band) =>
    buildGridAggregationFromFenceWindow({
      bands: [band],
      window,
      width,
      height,
      origin,
      resolution,
      fenceRings,
      gridCellWidth,
      gridCellHeight,
      sourceNoDataValue,
      metricTransform,
      aggregationMode,
      rotationDeg,
    }),
  );

  // 分类与处方波段始终以主波段为准
  const aggregation = aggregations[0];

  let resolvedNoDataValue: number;
  if (resolveNoDataValue) {
    resolvedNoDataValue = resolveNoDataValue(aggregation);
  } else if (noDataValue !== undefined) {
    resolvedNoDataValue = noDataValue;
  } else {
    throw new Error('导出需要 noDataValue 或 resolveNoDataValue 之一');
  }

  // Float32 输出时，像素里写入的是舍入后的哨兵；返回给调用方的值（用于写
  // GDAL_NODATA tag）也必须同步舍入，否则下游按等值比较会认不出掩膜像元。
  const outputNoDataValue =
    outputType === 'float32' ? Math.fround(resolvedNoDataValue) : resolvedNoDataValue;

  const rewrittenBands: SupportedRasterArray[] = [];
  let maskedPixelCount = 0;

  bands.forEach((band, index) => {
    const rewritten = applyGridAggregationToBands({
      bands: [band],
      aggregation: aggregations[index],
      width,
      height,
      window,
      origin,
      resolution,
      fenceRings,
      gridCellWidth,
      gridCellHeight,
      noDataValue: outputNoDataValue,
      metricTransform,
      rotationDeg,
      outputType,
    });

    rewrittenBands.push(rewritten.bands[0]);

    // 掩膜数量以主波段为准（与处方波段、GDAL_NODATA 口径一致）
    if (index === 0) {
      maskedPixelCount = rewritten.maskedPixelCount;
    }
  });

  return {
    aggregation,
    bands: rewrittenBands,
    maskedPixelCount,
    noDataValue: outputNoDataValue,
  };
}

export function pickExportNoDataValue(input: {
  sourceNoDataValue: number | null;
  sampleFormat: number[];
  bitsPerSample: number[];
  bands: SupportedRasterArray[];
  /** 不可被选作 NoData 的数值（例如已算出的网格聚合值） */
  reservedValues?: readonly number[];
}): number {
  const { sourceNoDataValue, sampleFormat, bitsPerSample, bands, reservedValues } = input;
  const reserved = new Set(reservedValues ?? []);

  // 源 NoData 优先复用，但它可能与某个网格的聚合值相同——那样该网格会被误判为无值
  if (
    sourceNoDataValue !== null &&
    Number.isFinite(sourceNoDataValue) &&
    !reserved.has(sourceNoDataValue)
  ) {
    return sourceNoDataValue;
  }

  const candidates = getNoDataCandidates(sampleFormat[0] ?? 1, bitsPerSample[0] ?? 8);

  for (const candidate of candidates) {
    if (!reserved.has(candidate) && !hasValueInBands(bands, candidate)) {
      return candidate;
    }
  }

  return candidates[0] ?? -9999;
}

/**
 * 收集聚合结果中所有有效的输出值。
 * 供 NoData 哨兵避让使用：哨兵不能等于任何一个真实的聚合值。
 */
export function collectAggregationOutputValues(aggregation: GridAggregationResult): number[] {
  const values: number[] = [];

  for (const cell of Object.values(aggregation.cellsById)) {
    if (cell.outputValue !== null && Number.isFinite(cell.outputValue)) {
      values.push(cell.outputValue);
    }
  }

  return values;
}
