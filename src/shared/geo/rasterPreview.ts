import { normalizeToByte } from './rasterColor';
import type { RasterValueRange } from '@/shared/types/raster';

const MAX_PREVIEW_EDGE = 2048;

/**
 * 统计 TIFF ExtraSamples(338) 声明的附加波段数量。
 * 附加波段总是排在末尾；geotiff.js 对单元素数组可能返回标量，两种形态都要兼容。
 */
export function countExtraSamples(fileDirectory: unknown): number {
  if (!fileDirectory || typeof fileDirectory !== 'object') {
    return 0;
  }

  const value = (fileDirectory as Record<string, unknown>).ExtraSamples;

  if (typeof value === 'number') {
    return Number.isFinite(value) ? 1 : 0;
  }

  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    return (value as ArrayLike<unknown>).length;
  }

  return 0;
}

/**
 * 计算真正承载影像数据的波段数：扣除由 ExtraSamples 声明的附加波段。
 *
 * 本工具 rules 模式导出时会追加一个 Float32 处方波段（并写 ExtraSamples），
 * 该文件被重新导入时应仍按主波段做分类着色，因此不能直接用 SamplesPerPixel 判断。
 */
export function resolveDataBandCount(samplesPerPixel: number, extraSamplesCount: number): number {
  if (!Number.isFinite(samplesPerPixel) || samplesPerPixel <= 0) {
    return 1;
  }

  const safeExtra =
    Number.isFinite(extraSamplesCount) && extraSamplesCount > 0 ? Math.floor(extraSamplesCount) : 0;

  return Math.max(1, Math.floor(samplesPerPixel) - safeExtra);
}

/**
 * 判断像元值是否有效：必须是有限数，且不等于 noDataValue。
 */
export function isValidRasterSample(value: number, noDataValue: number | null): boolean {
  return Number.isFinite(value) && (noDataValue === null || value !== noDataValue);
}

/**
 * 根据原始影像尺寸计算预览图尺寸，保证最长边不超过 maxEdge。
 */
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

/**
 * 从交错采样数组中统计每个波段的有效值范围（min/max）。
 * 若某波段无有效值，则返回 null。
 */
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

/**
 * 从交错多波段采样数据中提取指定单波段数据。
 */
export function extractInterleavedBand(
  samples: ArrayLike<number>,
  bandCount: number,
  bandIndex: number,
): Float32Array {
  if (bandCount <= 1) {
    return Float32Array.from(samples as ArrayLike<number>);
  }

  const pixelCount = Math.floor(samples.length / bandCount);
  const extracted = new Float32Array(pixelCount);

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    extracted[pixelIndex] = samples[pixelIndex * bandCount + bandIndex] ?? Number.NaN;
  }

  return extracted;
}

/**
 * 将采样数据合成为 RGBA 预览图。
 * 单波段时渲染为灰度；多波段时按波段映射到 R/G/B 通道。
 */
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

/**
 * 将 RGBA 数据绘制成 PNG 格式的 Data URL。
 * 仅在浏览器环境（存在 document）中可用。
 */
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
