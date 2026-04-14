import { fromArrayBuffer } from 'geotiff';

import { createMetricTransform, isLikelyProjectedCrs } from '@/shared/geo/crs';
import type {
  RasterClassificationLayer,
  RasterClassificationBreak,
  RasterClassificationRule,
  RasterGradientStop,
  RasterGeoKeys,
  RasterLayerMatchResult,
  RasterMetadata,
  RasterPreview,
  RasterRenderSettings,
  RasterValueRange,
  RasterValidityMask,
  RawRasterMetadata,
} from '@/shared/types/raster';

const MAX_VALIDITY_MASK_SIZE = 256;
const LOCAL_READ_START_PROGRESS = 5;
const MAX_PREVIEW_EDGE = 2048;
const DEFAULT_CLASSIFICATION_COLORS = [
  '#f5f5f4',
  '#e8e8e6',
  '#d9d9d6',
  '#bdbdb8',
  '#9f9f98',
  '#73736d',
  '#474743',
  '#171717',
];
const DEFAULT_NDVI_GRADIENT_STOPS = [
  { value: -1, color: '#8b1e3f', label: '低植被' },
  { value: 0, color: '#d7c98b', label: '裸地' },
  { value: 0.4, color: '#7fbf3f', label: '中等植被' },
  { value: 0.7, color: '#1f7a1f', label: '高植被' },
  { value: 1, color: '#0b3d0b', label: '极高植被' },
] satisfies readonly [RasterGradientStop, ...RasterGradientStop[]];

export type RasterClassificationLegendItem = {
  color: string;
  label: string;
};

export type RasterClassificationLegendData = {
  mode: RasterClassificationLayer['mode'];
  items: RasterClassificationLegendItem[];
  gradientCss: string | null;
};

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }

    setTimeout(resolve, 0);
  });
}

export function calculateProgressPercent(
  receivedBytes: number,
  totalBytes: number | null,
  previousProgress: number | null = null,
): number | null {
  if (!totalBytes || totalBytes <= 0) {
    if (receivedBytes <= 0 || previousProgress === null) {
      return null;
    }

    return Math.min(85, Math.max(5, previousProgress + 5));
  }

  const roundedProgress = Math.round((receivedBytes / totalBytes) * 100);
  if (receivedBytes > 0) {
    return Math.min(100, Math.max(1, roundedProgress));
  }

  return Math.min(100, roundedProgress);
}

export function getCrsCodeFromGeoKeys(geoKeys: RasterGeoKeys): string {
  if (geoKeys.ProjectedCSTypeGeoKey) {
    return `EPSG:${geoKeys.ProjectedCSTypeGeoKey}`;
  }

  if (geoKeys.GeographicTypeGeoKey) {
    return `EPSG:${geoKeys.GeographicTypeGeoKey}`;
  }

  return 'UNKNOWN';
}

export function buildRasterMetadata(raw: RawRasterMetadata): RasterMetadata {
  const crsCode = getCrsCodeFromGeoKeys(raw.geoKeys);
  const isProjected = crsCode !== 'UNKNOWN' ? isLikelyProjectedCrs(crsCode) : false;
  const cellSizeUnit = crsCode === 'UNKNOWN' ? 'unknown' : isProjected ? 'm' : 'degree';
  const metricTransform = createMetricTransform({
    crsCode,
    boundingBox: raw.boundingBox,
  });

  return {
    sourceUrl: raw.sourceUrl,
    fileName: raw.fileName,
    width: raw.width,
    height: raw.height,
    samplesPerPixel: raw.samplesPerPixel,
    boundingBox: raw.boundingBox,
    coordinateDisplayMode: metricTransform.coordinateDisplayMode,
    metricExtent: metricTransform.metricExtent,
    metricWidth: metricTransform.metricWidth,
    metricHeight: metricTransform.metricHeight,
    metricTransform,
    origin: raw.origin,
    resolution: raw.resolution,
    cellSize: {
      x: Math.abs(raw.resolution[0] ?? 0),
      y: Math.abs(raw.resolution[1] ?? 0),
      unit: cellSizeUnit,
    },
    crsCode,
    crsName: raw.geoKeys.GTCitationGeoKey || crsCode,
    isProjected,
  };
}

function normalizeNoDataValue(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const normalized = Number.parseFloat(value.replace(/\0/g, '').trim());
    return Number.isFinite(normalized) ? normalized : null;
  }

  return null;
}

function isValidRasterSample(value: number, noDataValue: number | null): boolean {
  return Number.isFinite(value) && (noDataValue === null || value !== noDataValue);
}

export function calculatePreviewDimensions(
  width: number,
  height: number,
  maxEdge: number = MAX_PREVIEW_EDGE,
): { width: number; height: number } {
  const longestEdge = Math.max(width, height);
  if (longestEdge <= 0 || longestEdge <= maxEdge) {
    return {
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    };
  }

  const scale = maxEdge / longestEdge;
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

function countDecimals(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const normalized = value.toString().toLowerCase();
  if (normalized.includes('e-')) {
    const [, exponent] = normalized.split('e-');
    return Number.parseInt(exponent ?? '0', 10) || 0;
  }

  const decimalPart = normalized.split('.')[1];
  return decimalPart ? decimalPart.length : 0;
}

function roundToPrecision(value: number, decimals: number): number {
  const factor = 10 ** Math.max(0, decimals);
  return Math.round(value * factor) / factor;
}

function formatRangeValue(value: number, decimals: number): string {
  return value.toFixed(Math.max(2, decimals));
}

function hexToRgb(color: string): [number, number, number] {
  const normalized = color.trim().replace('#', '');
  const hex =
    normalized.length === 3
      ? normalized
          .split('')
          .map((value) => `${value}${value}`)
          .join('')
      : normalized;

  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

function hexToRgba(color: string): [number, number, number, number] {
  const normalized = color.trim().replace('#', '');

  if (normalized.length === 4) {
    const [red, green, blue, alpha] = normalized.split('');
    return [
      Number.parseInt(`${red}${red}`, 16),
      Number.parseInt(`${green}${green}`, 16),
      Number.parseInt(`${blue}${blue}`, 16),
      Number.parseInt(`${alpha}${alpha}`, 16),
    ];
  }

  if (normalized.length === 8) {
    return [
      Number.parseInt(normalized.slice(0, 2), 16),
      Number.parseInt(normalized.slice(2, 4), 16),
      Number.parseInt(normalized.slice(4, 6), 16),
      Number.parseInt(normalized.slice(6, 8), 16),
    ];
  }

  const [red, green, blue] = hexToRgb(color);
  return [red, green, blue, 255];
}

function rgbToHex(red: number, green: number, blue: number): string {
  const toHex = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

function interpolateHexColors(startColor: string, endColor: string, ratio: number): string {
  const [startRed, startGreen, startBlue] = hexToRgb(startColor);
  const [endRed, endGreen, endBlue] = hexToRgb(endColor);
  const clampedRatio = Math.max(0, Math.min(1, ratio));

  return rgbToHex(
    startRed + (endRed - startRed) * clampedRatio,
    startGreen + (endGreen - startGreen) * clampedRatio,
    startBlue + (endBlue - startBlue) * clampedRatio,
  );
}

function findMatchingClassificationRule(
  value: number,
  rules: RasterClassificationRule[],
): RasterClassificationRule | null {
  for (const rule of rules) {
    if (value < rule.min) {
      continue;
    }

    if (rule.max === null || value < rule.max) {
      return rule;
    }
  }

  return null;
}

function cloneGradientStops(
  [firstStop, ...restStops]: readonly [RasterGradientStop, ...RasterGradientStop[]],
): [RasterGradientStop, ...RasterGradientStop[]] {
  return [
    { ...firstStop },
    ...restStops.map((stop) => ({ ...stop })),
  ];
}

function getGradientStopPercentages(
  [firstStop, ...restStops]: readonly [RasterGradientStop, ...RasterGradientStop[]],
): number[] {
  const stops = [firstStop, ...restStops];
  const minValue = stops[0].value;
  const maxValue = stops[stops.length - 1].value;
  const valueSpan = maxValue - minValue;

  if (valueSpan <= 0) {
    return stops.map((_, index) => {
      if (stops.length === 1) {
        return 100;
      }

      return (index / (stops.length - 1)) * 100;
    });
  }

  return stops.map((stop) => ((stop.value - minValue) / valueSpan) * 100);
}

export function buildRasterClassificationLegendData(
  layer: RasterClassificationLayer,
): RasterClassificationLegendData {
  if (layer.mode === 'rules') {
    return {
      mode: layer.mode,
      items: layer.rules.map((rule) => ({
        color: rule.color,
        label: rule.label,
      })),
      gradientCss: null,
    };
  }

  const percentages = getGradientStopPercentages(layer.gradientStops);
  const stops = layer.gradientStops.map((stop, index) => `${stop.color} ${percentages[index].toFixed(2)}%`);

  return {
    mode: layer.mode,
    items: layer.gradientStops.map((stop) => ({
      color: stop.color,
      label: stop.label,
    })),
    gradientCss: `linear-gradient(90deg, ${stops.join(', ')})`,
  };
}

export function buildDefaultNdviClassificationLayer(): RasterClassificationLayer {
  return {
    id: 'ndvi-default',
    label: 'NDVI 默认分级',
    mode: 'gradient',
    noDataColor: '#00000000',
    gradientStops: cloneGradientStops(DEFAULT_NDVI_GRADIENT_STOPS),
    rules: [],
  };
}

export function findRasterClassificationMatch(
  value: number,
  layer: RasterClassificationLayer,
): RasterLayerMatchResult | null {
  if (!Number.isFinite(value)) {
    return null;
  }

  if (layer.mode === 'rules') {
    const matchedRule = findMatchingClassificationRule(value, layer.rules);
    if (!matchedRule) {
      return null;
    }

    return {
      color: matchedRule.color,
      label: matchedRule.label,
      matchedRule,
    };
  }

  const stops = layer.gradientStops;
  if (stops.length === 0) {
    return null;
  }

  const exactStop = stops.find((stop) => value === stop.value);
  if (exactStop) {
    return {
      color: exactStop.color,
      label: exactStop.label,
      matchedRule: null,
    };
  }

  if (value <= stops[0].value) {
    return {
      color: stops[0].color,
      label: stops[0].label,
      matchedRule: null,
    };
  }

  const lastStop = stops[stops.length - 1];
  if (value >= lastStop.value) {
    return {
      color: lastStop.color,
      label: lastStop.label,
      matchedRule: null,
    };
  }

  for (let index = 0; index < stops.length - 1; index += 1) {
    const currentStop = stops[index];
    const nextStop = stops[index + 1];

    if (value < currentStop.value || value > nextStop.value) {
      continue;
    }

    const ratio = (value - currentStop.value) / (nextStop.value - currentStop.value);
    return {
      color: interpolateHexColors(currentStop.color, nextStop.color, ratio),
      label: `${currentStop.label} ~ ${nextStop.label}`,
      matchedRule: null,
    };
  }

  return {
    color: lastStop.color,
    label: lastStop.label,
    matchedRule: null,
  };
}

export function getSampleRanges(
  samples: ArrayLike<number>,
  bandCount: number,
  noDataValue: number | null,
): Array<RasterValueRange | null> {
  const ranges = Array.from({ length: bandCount }, () => ({
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
  }));

  for (let index = 0; index < samples.length; index += bandCount) {
    for (let bandIndex = 0; bandIndex < bandCount; bandIndex += 1) {
      const value = samples[index + bandIndex] ?? Number.NaN;
      if (!isValidRasterSample(value, noDataValue)) {
        continue;
      }

      ranges[bandIndex].min = Math.min(ranges[bandIndex].min, value);
      ranges[bandIndex].max = Math.max(ranges[bandIndex].max, value);
    }
  }

  return ranges.map((range) => {
    if (!Number.isFinite(range.min) || !Number.isFinite(range.max)) {
      return null;
    }

    return range;
  });
}

function normalizeToByte(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const normalized = ((value - min) / (max - min)) * 255;
  return Math.max(0, Math.min(255, Math.round(normalized)));
}

export function buildPreviewRgba(
  samples: ArrayLike<number>,
  width: number,
  height: number,
  bandCount: number,
  noDataValue: number | null,
): Uint8ClampedArray {
  const pixelCount = width * height;
  const rgba = new Uint8ClampedArray(pixelCount * 4);
  const effectiveBandCount = Math.max(1, Math.min(3, bandCount));
  const ranges = getSampleRanges(samples, effectiveBandCount, noDataValue).map((range) => {
    if (!range) {
      return { min: 0, max: 1 };
    }

    return range.max === range.min ? { min: range.min, max: range.min + 1 } : range;
  });

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const sampleOffset = pixelIndex * bandCount;
    const rgbaOffset = pixelIndex * 4;

    if (effectiveBandCount === 1) {
      const value = samples[sampleOffset] ?? Number.NaN;
      if (!isValidRasterSample(value, noDataValue)) {
        rgba[rgbaOffset + 3] = 0;
        continue;
      }

      const gray = normalizeToByte(value, ranges[0].min, ranges[0].max);
      rgba[rgbaOffset] = gray;
      rgba[rgbaOffset + 1] = gray;
      rgba[rgbaOffset + 2] = gray;
      rgba[rgbaOffset + 3] = 255;
      continue;
    }

    let transparent = true;
    for (let bandIndex = 0; bandIndex < effectiveBandCount; bandIndex += 1) {
      const value = samples[sampleOffset + bandIndex] ?? Number.NaN;
      if (isValidRasterSample(value, noDataValue)) {
        transparent = false;
      }

      rgba[rgbaOffset + bandIndex] = normalizeToByte(
        value,
        ranges[bandIndex].min,
        ranges[bandIndex].max,
      );
    }

    if (effectiveBandCount === 2) {
      rgba[rgbaOffset + 2] = rgba[rgbaOffset + 1];
    }

    rgba[rgbaOffset + 3] = transparent ? 0 : 255;
  }

  return rgba;
}

function getClassificationColor(index: number, total: number, colors: string[]): string {
  if (total <= 1) {
    return colors.at(Math.floor(colors.length / 2)) ?? colors[0] ?? '#777777';
  }

  const paletteIndex = Math.round((index / (total - 1)) * (colors.length - 1));
  return colors[Math.min(colors.length - 1, Math.max(0, paletteIndex))] ?? '#777777';
}

export function buildClassificationBreaks(
  range: RasterValueRange | null | undefined,
  settings: RasterRenderSettings,
  colors: string[] = DEFAULT_CLASSIFICATION_COLORS,
): RasterClassificationBreak[] {
  if (!range) {
    return [];
  }

  const step = settings.step > 0 ? settings.step : 0.2;
  const decimals = countDecimals(step);
  const min = settings.min ?? Math.floor(range.min / step) * step;
  const max = settings.max ?? Math.ceil(range.max / step) * step;
  const safeMax = max <= min ? min + step : max;
  const total = Math.max(1, Math.ceil((safeMax - min) / step));

  return Array.from({ length: total }, (_, index) => {
    const start = roundToPrecision(min + index * step, decimals + 4);
    const end =
      index === total - 1
        ? roundToPrecision(safeMax, decimals + 4)
        : roundToPrecision(Math.min(safeMax, min + (index + 1) * step), decimals + 4);

    return {
      min: start,
      max: end,
      color: getClassificationColor(index, total, colors),
      label: `${formatRangeValue(start, decimals)} ~ ${formatRangeValue(end, decimals)}`,
    };
  });
}

export function findClassificationBreakForValue(
  value: number,
  breaks: RasterClassificationBreak[],
): RasterClassificationBreak | null {
  if (!Number.isFinite(value) || breaks.length === 0) {
    return null;
  }

  if (value <= breaks[0].min) {
    return breaks[0];
  }

  const lastBreak = breaks[breaks.length - 1];
  if (value >= lastBreak.max) {
    return lastBreak;
  }

  for (const currentBreak of breaks) {
    if (value >= currentBreak.min && value < currentBreak.max) {
      return currentBreak;
    }
  }

  return lastBreak;
}

export function buildClassifiedPreviewRgba(
  samples: ArrayLike<number>,
  width: number,
  height: number,
  breaks: RasterClassificationBreak[],
  noDataValue: number | null,
): Uint8ClampedArray {
  const pixelCount = width * height;
  const rgba = new Uint8ClampedArray(pixelCount * 4);

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const value = samples[pixelIndex] ?? Number.NaN;
    const rgbaOffset = pixelIndex * 4;

    if (!isValidRasterSample(value, noDataValue)) {
      rgba[rgbaOffset + 3] = 0;
      continue;
    }

    const matchedBreak = findClassificationBreakForValue(value, breaks);
    if (!matchedBreak) {
      rgba[rgbaOffset + 3] = 0;
      continue;
    }

    const [red, green, blue] = hexToRgb(matchedBreak.color);
    rgba[rgbaOffset] = red;
    rgba[rgbaOffset + 1] = green;
    rgba[rgbaOffset + 2] = blue;
    rgba[rgbaOffset + 3] = 255;
  }

  return rgba;
}

export function buildRasterClassificationPreviewRgba(
  samples: ArrayLike<number>,
  width: number,
  height: number,
  layer: RasterClassificationLayer,
  noDataValue: number | null,
): Uint8ClampedArray {
  const pixelCount = width * height;
  const rgba = new Uint8ClampedArray(pixelCount * 4);

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const value = samples[pixelIndex] ?? Number.NaN;
    const rgbaOffset = pixelIndex * 4;

    if (!isValidRasterSample(value, noDataValue)) {
      const [red, green, blue, alpha] = hexToRgba(layer.noDataColor);
      rgba[rgbaOffset] = red;
      rgba[rgbaOffset + 1] = green;
      rgba[rgbaOffset + 2] = blue;
      rgba[rgbaOffset + 3] = alpha;
      continue;
    }

    const match = findRasterClassificationMatch(value, layer);
    if (!match) {
      rgba[rgbaOffset + 3] = 0;
      continue;
    }

    const [red, green, blue] = hexToRgb(match.color);
    rgba[rgbaOffset] = red;
    rgba[rgbaOffset + 1] = green;
    rgba[rgbaOffset + 2] = blue;
    rgba[rgbaOffset + 3] = 255;
  }

  return rgba;
}

export function buildValidityMask(
  samples: ArrayLike<number>,
  width: number,
  height: number,
  boundingBox: [number, number, number, number],
  noDataValue: number | null,
): RasterValidityMask {
  const data = new Uint8Array(width * height);

  for (let index = 0; index < width * height; index += 1) {
    data[index] = isValidRasterSample(samples[index] ?? Number.NaN, noDataValue) ? 1 : 0;
  }

  return {
    width,
    height,
    boundingBox,
    data,
  };
}

async function buildRasterValidityMask(image: Awaited<ReturnType<Awaited<ReturnType<typeof fromArrayBuffer>>['getImage']>>) {
  const imageWidth = image.getWidth();
  const imageHeight = image.getHeight();
  const longestEdge = Math.max(imageWidth, imageHeight);
  const scale = longestEdge > MAX_VALIDITY_MASK_SIZE ? MAX_VALIDITY_MASK_SIZE / longestEdge : 1;
  const maskWidth = Math.max(1, Math.round(imageWidth * scale));
  const maskHeight = Math.max(1, Math.round(imageHeight * scale));
  const noDataValue = normalizeNoDataValue(image.getGDALNoData?.() ?? image.fileDirectory?.GDAL_NODATA);
  const samples = await image.readRasters({
    width: maskWidth,
    height: maskHeight,
    interleave: true,
    samples: [0],
    fillValue: noDataValue ?? Number.NaN,
  });

  return buildValidityMask(
    samples as ArrayLike<number>,
    maskWidth,
    maskHeight,
    image.getBoundingBox() as [number, number, number, number],
    noDataValue,
  );
}

export function createPreviewDataUrl(width: number, height: number, rgba: Uint8ClampedArray): string {
  if (typeof document === 'undefined') {
    throw new Error('当前环境不支持生成影像预览');
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('无法创建预览画布');
  }

  const imageData = context.createImageData(width, height);
  imageData.data.set(rgba);
  context.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}

export async function fetchRasterBuffer(
  sourceUrl: string,
  onProgress?: (progress: number | null) => void,
): Promise<ArrayBuffer> {
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`GeoTIFF 下载失败: ${response.status}`);
  }

  const totalBytesHeader = response.headers.get('content-length');
  const totalBytes = totalBytesHeader ? Number(totalBytesHeader) : null;

  if (!response.body) {
    const buffer = await response.arrayBuffer();
    onProgress?.(100);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  let fallbackProgress = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (value) {
      chunks.push(value);
      receivedBytes += value.byteLength;
      const nextProgress = calculateProgressPercent(receivedBytes, totalBytes, fallbackProgress);
      if (nextProgress !== null) {
        fallbackProgress = nextProgress;
      }
      onProgress?.(nextProgress);
    }
  }

  const merged = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  onProgress?.(100);
  return merged.buffer;
}

export async function readBlobBuffer(
  file: Blob,
  onProgress?: (progress: number | null) => void,
): Promise<ArrayBuffer> {
  if (typeof FileReader !== 'undefined') {
    return await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();

      reader.onloadstart = () => {
        onProgress?.(LOCAL_READ_START_PROGRESS);
      };

      reader.onprogress = (event) => {
        const totalBytes = event.lengthComputable ? event.total : file.size;
        onProgress?.(calculateProgressPercent(event.loaded, totalBytes, 0));
      };

      reader.onerror = () => {
        reject(reader.error ?? new Error('GeoTIFF 本地文件读取失败'));
      };

      reader.onload = () => {
        const result = reader.result;
        if (!(result instanceof ArrayBuffer)) {
          reject(new Error('GeoTIFF 本地文件读取结果无效'));
          return;
        }

        onProgress?.(100);
        resolve(result);
      };

      reader.readAsArrayBuffer(file);
    });
  }

  onProgress?.(LOCAL_READ_START_PROGRESS);
  const buffer = await file.arrayBuffer();
  onProgress?.(100);
  return buffer;
}

export async function loadRasterMetadata(
  source: File | string,
  onProgress?: (progress: number | null, phase: string) => void,
): Promise<RasterMetadata> {
  const isUrlSource = typeof source === 'string';
  const fileName = isUrlSource ? source.split('/').pop() || 'unknown.tif' : source.name;

  onProgress?.(0, isUrlSource ? '正在下载影像' : '正在读取本地文件');
  const image = isUrlSource
    ? await (async () => {
        const arrayBuffer = await fetchRasterBuffer(source, (progress) => {
          onProgress?.(progress, '正在下载影像');
        });
        onProgress?.(90, '正在解析元信息');
        await waitForNextPaint();
        const tiff = await fromArrayBuffer(arrayBuffer);
        return await tiff.getImage();
      })()
    : await (async () => {
        const arrayBuffer = await readBlobBuffer(source, (progress) => {
          onProgress?.(progress, '正在读取本地文件');
        });

        onProgress?.(96, '正在解析元信息');
        await waitForNextPaint();
        const tiff = await fromArrayBuffer(arrayBuffer);
        return await tiff.getImage();
      })();

  onProgress?.(100, '正在整理地图参数');
  return buildRasterMetadata({
    sourceUrl: isUrlSource ? source : null,
    fileName,
    width: image.getWidth(),
    height: image.getHeight(),
    boundingBox: image.getBoundingBox() as [number, number, number, number],
    origin: image.getOrigin() as [number, number, number?],
    resolution: image.getResolution() as [number, number, number?],
    geoKeys: image.getGeoKeys() as RasterGeoKeys,
    samplesPerPixel: image.getSamplesPerPixel(),
  });
}

export async function loadRasterPreview(
  source: File | string,
  onProgress?: (progress: number | null, phase: string) => void,
): Promise<RasterPreview> {
  onProgress?.(5, '正在生成预览');
  const arrayBuffer =
    typeof source === 'string'
      ? await fetchRasterBuffer(source)
      : await readBlobBuffer(source, (progress) => {
          if (progress !== null && progress < 70) {
            onProgress?.(progress, '正在读取预览文件');
          }
        });

  onProgress?.(72, '正在读取预览像元');
  await waitForNextPaint();
  const tiff = await fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();
  const noDataValue = normalizeNoDataValue(image.getGDALNoData?.() ?? image.fileDirectory?.GDAL_NODATA);
  const previewSize = calculatePreviewDimensions(image.getWidth(), image.getHeight());
  const bandCount = image.getSamplesPerPixel() >= 3 ? 3 : 1;
  const samples = await image.readRasters({
    width: previewSize.width,
    height: previewSize.height,
    interleave: true,
    samples: bandCount === 3 ? [0, 1, 2] : [0],
    fillValue: noDataValue ?? Number.NaN,
  });

  onProgress?.(88, '正在合成预览图');
  await waitForNextPaint();
  const rgba = buildPreviewRgba(
    samples as ArrayLike<number>,
    previewSize.width,
    previewSize.height,
    bandCount,
    noDataValue,
  );

  return {
    url: createPreviewDataUrl(previewSize.width, previewSize.height, rgba),
    width: previewSize.width,
    height: previewSize.height,
    sampleBandCount: bandCount,
    sampleData: Float32Array.from(samples as ArrayLike<number>),
    sampleRanges: getSampleRanges(samples as ArrayLike<number>, bandCount, noDataValue),
    noDataValue,
  };
}

export async function loadRasterValidityMask(
  source: File | string,
  onProgress?: (progress: number | null, phase: string) => void,
): Promise<RasterValidityMask> {
  onProgress?.(0, '正在提取有效区域');

  const image =
    typeof source === 'string'
      ? await (await fromArrayBuffer(await fetchRasterBuffer(source))).getImage()
      : await (await fromArrayBuffer(await readBlobBuffer(source))).getImage();

  onProgress?.(45, '正在抽样有效像元');
  const validityMask = await buildRasterValidityMask(image);
  onProgress?.(100, '有效区域已就绪');
  return validityMask;
}
