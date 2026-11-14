import { fromArrayBuffer } from 'geotiff';

import { createMetricTransform, isLikelyProjectedCrs } from '@/shared/geo/crs';
import type {
  RasterGeoKeys,
  RasterMetadata,
  RasterPreview,
  RasterValidityMask,
  RawRasterMetadata,
} from '@/shared/types/raster';

import {
  buildPreviewRgba,
  calculatePreviewDimensions,
  countExtraSamples,
  createPreviewDataUrl,
  extractInterleavedBand,
  getSampleRanges,
  isValidRasterSample,
  resolveDataBandCount,
} from './rasterPreview';

const MAX_VALIDITY_MASK_SIZE = 256;
const LOCAL_READ_START_PROGRESS = 5;

type RasterSource = File | string;
type RasterImageHandle = Awaited<ReturnType<Awaited<ReturnType<typeof fromArrayBuffer>>['getImage']>>;

export type RasterSession = {
  source: RasterSource;
  getArrayBuffer: (onProgress?: (progress: number | null) => void) => Promise<ArrayBuffer>;
  getImage: () => Promise<RasterImageHandle>;
};

let fileRasterSessionCache = new WeakMap<File, RasterSession>();
const urlRasterSessionCache = new Map<string, RasterSession>();
/** 按内容指纹（名称+大小+修改时间）缓存，用于跨 postMessage 复用 */
const keyedRasterSessionCache = new Map<string, RasterSession>();

/**
 * 等待下一次浏览器重绘，用于将耗时操作拆分为多个任务块，避免阻塞主线程。
 */
export function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }

    setTimeout(resolve, 0);
  });
}

/**
 * 根据已接收字节数和总字节数计算下载进度百分比。
 * 当总字节数未知时，使用步进式回退策略。
 */
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

/**
 * 从 GeoTIFF 的 GeoKeys 中提取 CRS 编码字符串。
 */
export function getCrsCodeFromGeoKeys(geoKeys: RasterGeoKeys): string {
  if (geoKeys.ProjectedCSTypeGeoKey) {
    return `EPSG:${geoKeys.ProjectedCSTypeGeoKey}`;
  }

  if (geoKeys.GeographicTypeGeoKey) {
    return `EPSG:${geoKeys.GeographicTypeGeoKey}`;
  }

  return 'UNKNOWN';
}

/**
 * 将原始影像元数据转换为标准化的 RasterMetadata 对象。
 */
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

export function normalizeNoDataValue(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const normalized = Number.parseFloat(value.replace(/\0/g, '').trim());
    return Number.isFinite(normalized) ? normalized : null;
  }

  return null;
}

/**
 * 根据采样数据构建有效像元掩膜。
 */
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

/**
 * 从 GeoTIFF 图像对象中读取并构建降采样后的有效区域掩膜。
 */
export async function buildRasterValidityMask(image: RasterImageHandle) {
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

/**
 * 通过网络请求获取 GeoTIFF 文件的 ArrayBuffer，支持进度回调。
 */
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

/**
 * 使用 FileReader 或 Blob.arrayBuffer() 读取本地文件的 ArrayBuffer，支持进度回调。
 */
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

function createRasterSession(source: RasterSource): RasterSession {
  let bufferPromise: Promise<ArrayBuffer> | null = null;
  let imagePromise: Promise<RasterImageHandle> | null = null;

  const getArrayBuffer = (onProgress?: (progress: number | null) => void) => {
    if (!bufferPromise) {
      bufferPromise = (
        typeof source === 'string'
          ? fetchRasterBuffer(source, onProgress)
          : readBlobBuffer(source, onProgress)
      ).catch((error) => {
        bufferPromise = null;
        throw error;
      });

      return bufferPromise;
    }

    return bufferPromise.then((buffer) => {
      onProgress?.(100);
      return buffer;
    });
  };

  const getImage = () => {
    if (!imagePromise) {
      imagePromise = (async () => {
        const arrayBuffer = await getArrayBuffer();
        const tiff = await fromArrayBuffer(arrayBuffer);
        return await tiff.getImage();
      })().catch((error) => {
        imagePromise = null;
        throw error;
      });
    }

    return imagePromise;
  };

  return {
    source,
    getArrayBuffer,
    getImage,
  };
}

/**
 * 打开或复用指定数据源的 RasterSession。
 * URL 使用 Map 缓存，File 使用 WeakMap 缓存。
 */
/**
 * 生成数据源的稳定缓存键。
 *
 * 为什么需要它：Worker 侧收到的是 `postMessage` 结构化克隆后的 `File`，
 * 每次请求都是**不同对象**，按对象身份做的 `WeakMap` 缓存必然失效——
 * 同一份影像会被完整读取并解析多次（预览一次、有效掩膜再一次）。
 * 用一个由 名称+大小+修改时间 组成的字符串作为键，才能跨请求复用同一个会话。
 */
export function buildRasterSourceKey(source: Blob): string {
  const named = source as Blob & { name?: string; lastModified?: number };
  const name = typeof named.name === 'string' ? named.name : '';
  const lastModified = typeof named.lastModified === 'number' ? named.lastModified : 0;

  return `${name}:${source.size}:${lastModified}`;
}

/**
 * 打开或复用指定数据源的 RasterSession。
 *
 * 缓存键优先级：显式 `cacheKey`（跨线程场景）> URL 字符串 > File 对象身份。
 */
export function openRasterSession(
  source: RasterSource,
  options: { cacheKey?: string } = {},
): RasterSession {
  const { cacheKey } = options;

  if (cacheKey) {
    const keyedSession = keyedRasterSessionCache.get(cacheKey);
    if (keyedSession) {
      return keyedSession;
    }

    const nextSession = createRasterSession(source);
    keyedRasterSessionCache.set(cacheKey, nextSession);
    return nextSession;
  }

  if (typeof source === 'string') {
    const existingSession = urlRasterSessionCache.get(source);
    if (existingSession) {
      return existingSession;
    }

    const nextSession = createRasterSession(source);
    urlRasterSessionCache.set(source, nextSession);
    return nextSession;
  }

  const existingSession = fileRasterSessionCache.get(source);
  if (existingSession) {
    return existingSession;
  }

  const nextSession = createRasterSession(source);
  fileRasterSessionCache.set(source, nextSession);
  return nextSession;
}

/**
 * 清空所有 RasterSession 缓存。
 */
export function resetRasterSessionCache() {
  fileRasterSessionCache = new WeakMap<File, RasterSession>();
  urlRasterSessionCache.clear();
  keyedRasterSessionCache.clear();
}

/**
 * 加载并构建影像的元数据信息。
 */
export async function loadRasterMetadata(
  source: File | string,
  onProgress?: (progress: number | null, phase: string) => void,
): Promise<RasterMetadata> {
  const isUrlSource = typeof source === 'string';
  const fileName = isUrlSource ? source.split('/').pop() || 'unknown.tif' : source.name;
  const session = openRasterSession(source);

  onProgress?.(0, isUrlSource ? '正在下载影像' : '正在读取本地文件');
  const image = isUrlSource
    ? await (async () => {
        await session.getArrayBuffer((progress) => {
          onProgress?.(progress, '正在下载影像');
        });
        onProgress?.(90, '正在解析元信息');
        await waitForNextPaint();
        return await session.getImage();
      })()
    : await (async () => {
        await session.getArrayBuffer((progress) => {
          onProgress?.(progress, '正在读取本地文件');
        });

        onProgress?.(96, '正在解析元信息');
        await waitForNextPaint();
        return await session.getImage();
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

/**
 * 加载影像预览数据，包括缩略图、采样范围和波段统计。
 */
export async function loadRasterPreview(
  source: File | string,
  onProgress?: (progress: number | null, phase: string) => void,
  options: { maxEdge?: number; cacheKey?: string } = {},
): Promise<RasterPreview> {
  const session = openRasterSession(source, { cacheKey: options.cacheKey });
  onProgress?.(5, '正在生成预览');
  await session.getArrayBuffer(
    typeof source === 'string'
      ? undefined
      : (progress) => {
          if (progress !== null && progress < 70) {
            onProgress?.(progress, '正在读取预览文件');
          }
        },
  );

  onProgress?.(72, '正在读取预览像元');
  await waitForNextPaint();
  const image = await session.getImage();
  const noDataValue = normalizeNoDataValue(image.getGDALNoData?.() ?? image.fileDirectory?.GDAL_NODATA);
  const previewSize = calculatePreviewDimensions(image.getWidth(), image.getHeight(), options.maxEdge);
  const samplesPerPixel = image.getSamplesPerPixel();
  // 导出文件会在末尾追加处方波段（并以 ExtraSamples 声明），分类判定要把它排除
  const classificationBandCount = resolveDataBandCount(
    samplesPerPixel,
    countExtraSamples(image.getFileDirectory?.()),
  );
  const bandCount = Math.min(3, Math.max(1, samplesPerPixel));
  const samples = await image.readRasters({
    width: previewSize.width,
    height: previewSize.height,
    interleave: true,
    samples: Array.from({ length: bandCount }, (_, index) => index),
    fillValue: noDataValue ?? Number.NaN,
  });
  const previewSamples =
    bandCount === 2 ? extractInterleavedBand(samples as ArrayLike<number>, bandCount, 0) : (samples as ArrayLike<number>);

  onProgress?.(88, '正在合成预览图');
  await waitForNextPaint();
  const rgba = buildPreviewRgba(
    previewSamples,
    previewSize.width,
    previewSize.height,
    bandCount === 2 ? 1 : bandCount,
    noDataValue,
  );

  return {
    url: createPreviewDataUrl(previewSize.width, previewSize.height, rgba),
    width: previewSize.width,
    height: previewSize.height,
    sampleBandCount: bandCount,
    classificationBandCount,
    sampleData: Float32Array.from(samples as ArrayLike<number>),
    sampleRanges: getSampleRanges(samples as ArrayLike<number>, bandCount, noDataValue),
    noDataValue,
  };
}

/**
 * 加载影像的有效像元掩膜，用于后续的几何裁剪与范围校验。
 */
export async function loadRasterValidityMask(
  source: File | string,
  onProgress?: (progress: number | null, phase: string) => void,
): Promise<RasterValidityMask> {
  onProgress?.(0, '正在提取有效区域');
  const image = await openRasterSession(source).getImage();

  onProgress?.(45, '正在抽样有效像元');
  const validityMask = await buildRasterValidityMask(image);
  onProgress?.(100, '有效区域已就绪');
  return validityMask;
}
