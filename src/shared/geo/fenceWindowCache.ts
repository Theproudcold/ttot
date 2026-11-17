import { getFenceSummary } from '@/shared/geo/fence';
import { getPixelWindowFromFenceBoundingBox } from '@/shared/geo/rasterWindow';
import { buildRasterSourceKey, normalizeNoDataValue, openRasterSession } from '@/shared/geo/rasterIo';
import type { RasterImageHandle } from '@/shared/geo/rasterIo';
import type { FenceRings } from '@/shared/types/fence';
import type {
  PixelWindow,
  RasterOrigin,
  RasterResolution,
  SupportedRasterArray,
} from '@/shared/types/raster';

/**
 * 围栏窗口的解码结果（聚合与导出共同需要的像元部分）。
 */
export type FenceWindowData = {
  window: PixelWindow;
  width: number;
  height: number;
  bands: SupportedRasterArray[];
  origin: RasterOrigin;
  resolution: RasterResolution;
  sourceNoDataValue: number | null;
};

/**
 * 最多缓存两个窗口：当前窗口 + 上一个窗口。
 * 网格尺寸、旋转角度、聚合模式的变化都命中同一份解码结果，只有围栏外接框变了才会重新解码。
 */
const MAX_CACHE_ENTRIES = 2;
/** 缓存像素总量上限（约 256 MB/单波段 Float32），超出后只保留最近使用的一个窗口。 */
const MAX_CACHED_PIXELS = 64_000_000;

const fenceWindowCache = new Map<string, FenceWindowData>();

/**
 * 清空围栏窗口缓存（测试与切换影像时使用）。
 */
export function resetFenceWindowCache(): void {
  fenceWindowCache.clear();
}

function normalizeRasterBands(rasters: unknown): SupportedRasterArray[] {
  if (!Array.isArray(rasters)) {
    throw new Error('GeoTIFF 栅格窗口读取结果无效');
  }

  return rasters as SupportedRasterArray[];
}

/**
 * 淘汰最久未使用的窗口，直到满足条目数与像素总量预算。
 * 始终保留最近使用的一个，避免刚解码完就被立刻丢掉。
 */
function trimCache(): void {
  let cachedPixels = 0;
  for (const entry of fenceWindowCache.values()) {
    cachedPixels += entry.width * entry.height;
  }

  while (
    fenceWindowCache.size > 1 &&
    (fenceWindowCache.size > MAX_CACHE_ENTRIES || cachedPixels > MAX_CACHED_PIXELS)
  ) {
    const oldestKey = fenceWindowCache.keys().next().value;
    if (oldestKey === undefined) {
      return;
    }

    const evicted = fenceWindowCache.get(oldestKey);
    if (!evicted) {
      return;
    }

    cachedPixels -= evicted.width * evicted.height;
    fenceWindowCache.delete(oldestKey);
  }
}

/**
 * 读取并缓存围栏外接框对应的栅格窗口。
 *
 * 为什么需要缓存：解码是这条链路上最贵的一步（实测 5647×3179 影像的
 * 2824×1590 窗口约 258 ms，全分辨率约 716 ms），而网格尺寸/旋转/聚合模式
 * 的每次调整都只需要同一份像元。此前解码结果会随 postMessage 转移出线程，
 * 导致每次调参都必须重新解码。
 */
export async function readFenceWindowWithCache(input: {
  source: File | string;
  sourceKey?: string;
  fenceRings: FenceRings;
  samples?: number[];
  /**
   * 已打开的影像句柄。主线程调用方通常已经为了读元信息而打开过会话，
   * 传进来可以避免同一份文件在两条路径上各解析一次。
   */
  image?: RasterImageHandle;
}): Promise<FenceWindowData> {
  const { source, sourceKey, fenceRings } = input;
  const sampleIndexes = input.samples && input.samples.length > 0 ? input.samples : [0];
  // 会话与窗口缓存都用内容指纹做键：Worker 收到的是结构化克隆后的新 File 对象，
  // 按对象身份缓存必然落空，同一份影像会被反复解析。
  const sourceIdentity = sourceKey ?? buildRasterSourceKey(source);

  const image =
    input.image ?? (await openRasterSession(source, { cacheKey: sourceIdentity }).getImage());
  const origin = image.getOrigin() as RasterOrigin;
  const resolution = image.getResolution() as RasterResolution;
  const window = getPixelWindowFromFenceBoundingBox({
    bbox: getFenceSummary(fenceRings).bbox,
    rasterWidth: image.getWidth(),
    rasterHeight: image.getHeight(),
    origin,
    resolution,
  });

  const cacheKey = `${sourceIdentity}|${sampleIndexes.join(',')}|${window.join(',')}`;
  const cached = fenceWindowCache.get(cacheKey);

  if (cached) {
    // 命中后挪到队尾，保持 LRU 语义
    fenceWindowCache.delete(cacheKey);
    fenceWindowCache.set(cacheKey, cached);
    return cached;
  }

  const bands = normalizeRasterBands(
    await image.readRasters({ window, interleave: false, samples: sampleIndexes }),
  );
  const fileDirectory = (image.getFileDirectory?.() ?? {}) as Record<string, unknown>;
  const data: FenceWindowData = {
    window,
    width: window[2] - window[0],
    height: window[3] - window[1],
    bands,
    origin,
    resolution,
    sourceNoDataValue: normalizeNoDataValue(
      image.getGDALNoData?.() ?? fileDirectory.GDAL_NODATA ?? null,
    ),
  };

  fenceWindowCache.set(cacheKey, data);
  trimCache();

  return data;
}
