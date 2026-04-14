import { isPointInFence } from '@/shared/geo/fence';
import type { FenceBoundingBox, FencePosition, FenceRings } from '@/shared/types/fence';
import type { RasterOrigin, RasterResolution } from '@/shared/types/raster';

type SupportedRasterArray =
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Float32Array
  | Float64Array;

type PixelWindow = [number, number, number, number];

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

export function applyFenceNoDataMask<T extends SupportedRasterArray>(input: {
  bands: T[];
  window: PixelWindow;
  width: number;
  height: number;
  origin: RasterOrigin;
  resolution: RasterResolution;
  fenceRings: FenceRings;
  noDataValue: number;
}): T[] {
  const { bands, window, width, height, origin, resolution, fenceRings, noDataValue } = input;
  const [windowStartCol, windowStartRow] = window;

  return bands.map((band) => {
    const TypedArrayConstructor = getTypedArrayConstructor(band);
    const clonedBand = new TypedArrayConstructor(band.length);
    clonedBand.set(band);

    for (let row = 0; row < height; row += 1) {
      for (let col = 0; col < width; col += 1) {
        const [centerX, centerY] = getPixelCenter(
          windowStartCol + col,
          windowStartRow + row,
          origin,
          resolution,
        );

        if (!isPointInFence([centerX, centerY], fenceRings)) {
          clonedBand[row * width + col] = noDataValue;
        }
      }
    }

    return clonedBand;
  });
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
