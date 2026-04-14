import { fromArrayBuffer } from 'geotiff';

import type { MetricTransform } from '@/shared/geo/crs';
import { getFenceSummary, isPointInFence } from '@/shared/geo/fence';
import {
  aggregateGridCellsFromRasterWindow,
  applyGridAggregationToBands,
} from '@/shared/geo/gridAggregation';
import { readBlobBuffer } from '@/shared/geo/raster';
import type { FenceBoundingBox, FencePosition, FenceRings } from '@/shared/types/fence';
import type { GridAggregationResult } from '@/shared/types/grid';
import type { RasterOrigin, RasterResolution } from '@/shared/types/raster';

export type SupportedRasterArray =
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Float32Array
  | Float64Array;

export type PixelWindow = [number, number, number, number];

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

function getRasterExtent(
  rasterWidth: number,
  rasterHeight: number,
  origin: RasterOrigin,
  resolution: RasterResolution,
): FenceBoundingBox {
  const [originX, originY] = origin;
  const [resolutionX, resolutionY] = resolution;
  const maxX = originX + rasterWidth * resolutionX;
  const minY = originY + rasterHeight * resolutionY;

  return [
    Math.min(originX, maxX),
    Math.min(originY, minY),
    Math.max(originX, maxX),
    Math.max(originY, minY),
  ];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

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

export function getPixelWindowFromFenceBoundingBox(input: {
  bbox: FenceBoundingBox;
  rasterWidth: number;
  rasterHeight: number;
  origin: RasterOrigin;
  resolution: RasterResolution;
}): PixelWindow {
  const { bbox, rasterWidth, rasterHeight, origin, resolution } = input;
  const [minX, minY, maxX, maxY] = bbox;
  const [originX, originY] = origin;
  const [resolutionX, resolutionY] = resolution;
  const [rasterMinX, rasterMinY, rasterMaxX, rasterMaxY] = getRasterExtent(
    rasterWidth,
    rasterHeight,
    origin,
    resolution,
  );

  if (maxX <= rasterMinX || minX >= rasterMaxX || maxY <= rasterMinY || minY >= rasterMaxY) {
    throw new Error('围栏超出影像范围');
  }

  const safeResolutionX = resolutionX || Number.EPSILON;
  const safeResolutionY = resolutionY || -Number.EPSILON;

  const startCol = clamp(Math.floor((minX - originX) / safeResolutionX), 0, rasterWidth - 1);
  const endCol = clamp(Math.ceil((maxX - originX) / safeResolutionX), 1, rasterWidth);
  const startRow = clamp(Math.floor((maxY - originY) / safeResolutionY), 0, rasterHeight - 1);
  const endRow = clamp(Math.ceil((minY - originY) / safeResolutionY), 1, rasterHeight);

  return [Math.min(startCol, endCol - 1), Math.min(startRow, endRow - 1), endCol, endRow];
}

export async function readGeoTiffFenceWindow(input: {
  file: File;
  fenceRings: FenceRings;
  samples?: number[];
}): Promise<GeoTiffFenceWindowData> {
  const { file, fenceRings, samples } = input;
  const arrayBuffer = await readBlobBuffer(file);
  const tiff = await fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();
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
  });
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
  noDataValue: number;
  metricTransform?: MetricTransform;
}): { aggregation: GridAggregationResult; bands: Float64Array[]; maskedPixelCount: number } {
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
    metricTransform,
  } = input;
  const aggregation = buildGridAggregationFromFenceWindow({
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
  });
  const rewritten = applyGridAggregationToBands({
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
  });

  return {
    aggregation,
    bands: rewritten.bands,
    maskedPixelCount: rewritten.maskedPixelCount,
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
}): number {
  const { sourceNoDataValue, sampleFormat, bitsPerSample, bands } = input;

  if (sourceNoDataValue !== null && Number.isFinite(sourceNoDataValue)) {
    return sourceNoDataValue;
  }

  const candidates = getNoDataCandidates(sampleFormat[0] ?? 1, bitsPerSample[0] ?? 8);

  for (const candidate of candidates) {
    if (!hasValueInBands(bands, candidate)) {
      return candidate;
    }
  }

  return candidates[0] ?? -9999;
}
