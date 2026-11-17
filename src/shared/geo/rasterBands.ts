/**
 * 按需读取指定波段的采样数据（预览分辨率）。
 *
 * 为什么不复用 `RasterPreview.sampleData`：它只采样前 `min(3, spp)` 个波段，
 * 而 NDVI 需要 NIR、NDRE 需要红边——5 波段影像用前 3 个波段算出来的"NDVI"
 * 实际是别的组合，属于**静默算错**。所以植被指数走这条专门的读取路径。
 *
 * 采样分辨率与预览一致（默认 1024 边长），足以统计分布与生成分级断点，
 * 又不必把整幅影像读进内存。
 */

import {
  calculatePreviewDimensions,
  resolveDataBandCount,
  countExtraSamples,
} from './rasterPreview';
import { buildRasterSourceKey, openRasterSession } from './rasterIo';

export type RasterBandSamples = {
  width: number;
  height: number;
  /** 实际读取的波段数 */
  sampleCount: number;
  /** 按波段索引顺序排列 */
  bands: Float32Array[];
  /** 每个波段的 GDAL 元数据项（可能为空对象） */
  metadataByBand: Array<Record<string, unknown>>;
  noDataValue: number | null;
  /** 承载影像数据的波段数（已排除附加波段） */
  dataBandCount: number;
};

const DEFAULT_BAND_SAMPLE_MAX_EDGE = 1024;
/** 一次最多读取的波段数，避免异常文件把内存打满 */
const MAX_BAND_SAMPLES = 16;

function readMetadata(image: unknown, sampleIndex: number): Record<string, unknown> {
  const holder = image as { getGDALMetadata?: (sample?: number | null) => unknown };

  if (typeof holder.getGDALMetadata !== 'function') {
    return {};
  }

  try {
    const items = holder.getGDALMetadata(sampleIndex);

    if (items && typeof items === 'object') {
      return items as Record<string, unknown>;
    }
  } catch {
    // 元数据缺失或格式异常都不影响指数计算
  }

  return {};
}

export async function loadRasterBandSamples(
  source: File | string,
  options: { maxEdge?: number; maxSamples?: number; cacheKey?: string } = {},
): Promise<RasterBandSamples> {
  const maxEdge = options.maxEdge ?? DEFAULT_BAND_SAMPLE_MAX_EDGE;
  const maxSamples = Math.min(
    MAX_BAND_SAMPLES,
    Math.max(1, Math.floor(options.maxSamples ?? MAX_BAND_SAMPLES)),
  );

  const session = openRasterSession(source, { cacheKey: options.cacheKey });
  const image = await session.getImage();

  const samplesPerPixel = image.getSamplesPerPixel();
  const sampleCount = Math.min(samplesPerPixel, maxSamples);
  const size = calculatePreviewDimensions(image.getWidth(), image.getHeight(), maxEdge);
  const noDataValue = normalizeNoData(
    image.getGDALNoData?.() ?? image.fileDirectory?.GDAL_NODATA ?? null,
  );

  const rasters = await image.readRasters({
    width: size.width,
    height: size.height,
    interleave: false,
    samples: Array.from({ length: sampleCount }, (_, index) => index),
    fillValue: noDataValue ?? Number.NaN,
  });

  const bands = Array.from({ length: sampleCount }, (_, index) => {
    const band = (rasters as ArrayLike<number>[])[index];
    return band instanceof Float32Array ? band : Float32Array.from(band ?? []);
  });

  return {
    width: size.width,
    height: size.height,
    sampleCount,
    bands,
    metadataByBand: Array.from({ length: sampleCount }, (_, index) => readMetadata(image, index)),
    noDataValue,
    dataBandCount: resolveDataBandCount(samplesPerPixel, countExtraSamples(image.getFileDirectory?.())),
  };
}

function normalizeNoData(value: unknown): number | null {
  const parsed =
    typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : null;

  return parsed !== null && Number.isFinite(parsed) ? parsed : null;
}

/**
 * 采样数据的缓存键。
 *
 * 必须与 `useRasterLoader` 传给 Worker 的 `sourceKey` **完全一致**（即裸的内容指纹，
 * 不加任何前缀），否则会开出两个解析会话，反而多读一次影像。
 */
export function buildBandSampleCacheKey(source: File): string {
  return buildRasterSourceKey(source);
}

/**
 * 逐波段均值（忽略非有限值）。
 * 供波段识别的兜底启发式使用：NIR 反射率通常最高、Red 因叶绿素吸收偏低。
 */
export function computeBandMeans(bands: ReadonlyArray<ArrayLike<number>>): Array<number | null> {
  return bands.map((band) => {
    let sum = 0;
    let count = 0;

    for (let index = 0; index < band.length; index += 1) {
      const value = band[index];
      if (Number.isFinite(value)) {
        sum += value;
        count += 1;
      }
    }

    return count > 0 ? sum / count : null;
  });
}
