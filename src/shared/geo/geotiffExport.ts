import type { MetricTransform } from '@/shared/geo/crs';
import { getFenceSummary, isPointInFence } from '@/shared/geo/fence';
import {
  aggregateGridCellsFromRasterWindow,
  aggregateGridCellsFromRasterWindowAsync,
  applyGridAggregationToBands,
} from '@/shared/geo/gridAggregation';
import { openRasterSession } from '@/shared/geo/raster';
import { getPixelWindowFromFenceBoundingBox } from '@/shared/geo/rasterWindow';
import type { FencePosition, FenceRings } from '@/shared/types/fence';
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

function normalizeRasterBands(rasters: unknown): SupportedRasterArray[] {
  if (!Array.isArray(rasters)) {
    throw new Error('GeoTIFF 栅格窗口读取结果无效');
  }

  return rasters as SupportedRasterArray[];
}

function normalizeNoDataValue(value: unknown): number | null {
  const parsed =
    typeof value === 'string'
      ? Number(value)
      : typeof value === 'number'
        ? value
        : null;

  return parsed !== null && Number.isFinite(parsed) ? parsed : null;
}

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

function getTypedArrayConstructor<T extends SupportedRasterArray>(
  band: T,
): new (length: number) => T {
  return band.constructor as new (length: number) => T;
}

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

function resolveMetricTransform(fenceRings: FenceRings, metricTransform?: MetricTransform): MetricTransform {
  return metricTransform ?? createIdentityMetricTransform(fenceRings);
}

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
  const image = await openRasterSession(file).getImage();
  const origin = image.getOrigin() as RasterOrigin;
  const resolution = image.getResolution() as RasterResolution;
  const window = getPixelWindowFromFenceBoundingBox({
    bbox: getFenceSummary(fenceRings).bbox,
    rasterWidth: image.getWidth(),
    rasterHeight: image.getHeight(),
    origin,
    resolution,
  });
  const sampleIndexes =
    samples && samples.length > 0
      ? samples
      : Array.from({ length: image.getSamplesPerPixel() }, (_, index) => index);
  const bands = normalizeRasterBands(
    await image.readRasters({
      window,
      interleave: false,
      samples: sampleIndexes,
    }),
  );
  const fileDirectory = (image.getFileDirectory?.() ?? {}) as Record<string, unknown>;
  const sourceNoDataValue = normalizeNoDataValue(
    image.getGDALNoData?.() ?? fileDirectory.GDAL_NODATA ?? null,
  );

  return {
    window,
    width: window[2] - window[0],
    height: window[3] - window[1],
    bands,
    origin,
    resolution,
    sourceNoDataValue,
    bitsPerSample: sampleIndexes.map((index) => image.getBitsPerSample(index)),
    sampleFormat: sampleIndexes.map((index) => image.getSampleFormat(index)),
    samplesPerPixel: sampleIndexes.length,
    fileDirectory,
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
      noDataValue: resolvedNoDataValue,
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
    noDataValue: resolvedNoDataValue,
  };
}

export function applyGridNoDataMask<T extends SupportedRasterArray>(input: {
  bands: T[];
  window: PixelWindow;
  width: number;
  height: number;
  origin: RasterOrigin;
  resolution: RasterResolution;
  fenceRings: FenceRings;
  gridCellWidth: number;
  gridCellHeight: number;
  noDataValue: number;
  metricTransform?: MetricTransform;
}): { bands: T[]; maskedPixelCount: number } {
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
    noDataValue,
    metricTransform,
  } = input;
  const resolvedMetricTransform = resolveMetricTransform(fenceRings, metricTransform);
  const [windowStartCol, windowStartRow] = window;
  const [gridMinX, gridMinY, gridMaxX, gridMaxY] = getMetricBounds(fenceRings, resolvedMetricTransform);
  const cols = Math.ceil((gridMaxX - gridMinX) / gridCellWidth);
  const rows = Math.ceil((gridMaxY - gridMinY) / gridCellHeight);
  const includedGridKeys = new Set<string>();

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const cellMinX = gridMinX + col * gridCellWidth;
      const cellMinY = gridMinY + row * gridCellHeight;
      const cellMaxX = Math.min(cellMinX + gridCellWidth, gridMaxX);
      const cellMaxY = Math.min(cellMinY + gridCellHeight, gridMaxY);
      const center = resolvedMetricTransform.fromMetric([
        (cellMinX + cellMaxX) / 2,
        (cellMinY + cellMaxY) / 2,
      ]);

      if (isPointInFence(center, fenceRings)) {
        includedGridKeys.add(`${row}:${col}`);
      }
    }
  }

  let maskedPixelCount = 0;

  const maskedBands = bands.map((band) => {
    const TypedArrayConstructor = getTypedArrayConstructor(band);
    const clonedBand = new TypedArrayConstructor(band.length);
    clonedBand.set(band);

    for (let row = 0; row < height; row += 1) {
      for (let col = 0; col < width; col += 1) {
        const [centerX, centerY] = resolvedMetricTransform.toMetric(
          getPixelCenter(windowStartCol + col, windowStartRow + row, origin, resolution),
        );
        const gridCol = Math.floor((centerX - gridMinX) / gridCellWidth);
        const gridRow = Math.floor((centerY - gridMinY) / gridCellHeight);
        const gridKey = `${gridRow}:${gridCol}`;

        if (
          gridCol < 0 ||
          gridCol >= cols ||
          gridRow < 0 ||
          gridRow >= rows ||
          !includedGridKeys.has(gridKey)
        ) {
          clonedBand[row * width + col] = noDataValue;
        }
      }
    }

    return clonedBand;
  });

  if (maskedBands[0]) {
    for (let pixelIndex = 0; pixelIndex < maskedBands[0].length; pixelIndex += 1) {
      if (maskedBands[0][pixelIndex] === noDataValue && bands[0]?.[pixelIndex] !== noDataValue) {
        maskedPixelCount += 1;
      }
    }
  }

  return {
    bands: maskedBands,
    maskedPixelCount,
  };
}

export function buildGeoTiffExportMetadata(input: {
  width: number;
  height: number;
  origin: RasterOrigin;
  resolution: RasterResolution;
  bitsPerSample: number[];
  sampleFormat: number[];
  samplesPerPixel: number;
  geoKeys: Record<string, number | string>;
  noDataValue: number;
  photometricInterpretation?: number;
}): Record<string, number | string | number[]> {
  const {
    width,
    height,
    origin,
    resolution,
    bitsPerSample,
    sampleFormat,
    samplesPerPixel,
    geoKeys,
    noDataValue,
    photometricInterpretation,
  } = input;
  const [originX, originY, originZ = 0] = origin;
  const [resolutionX, resolutionY] = resolution;

  return {
    ImageWidth: width,
    ImageLength: height,
    SamplesPerPixel: samplesPerPixel,
    BitsPerSample: bitsPerSample,
    SampleFormat: sampleFormat,
    PhotometricInterpretation:
      photometricInterpretation ?? (samplesPerPixel === 3 ? 2 : 1),
    PlanarConfiguration: 1,
    ModelPixelScale: [Math.abs(resolutionX), Math.abs(resolutionY), 0],
    ModelTiepoint: [0, 0, 0, originX, originY, originZ],
    GDAL_NODATA: String(noDataValue),
    ...geoKeys,
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
