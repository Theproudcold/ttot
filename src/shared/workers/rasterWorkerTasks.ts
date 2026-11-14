import { createMetricTransformFromDescriptor } from '@/shared/geo/crs';
import { buildGeoTiffExportBytes } from '@/features/export/exportGeoTiff';
import { readEmbeddedProjectSnapshotWithSession } from '@/features/project/readEmbeddedSnapshot';
import { readFenceWindowWithCache } from '@/shared/geo/fenceWindow';
import { aggregateGridCellsFromRasterWindow } from '@/shared/geo/gridAggregation';
import { buildRasterClassificationPreviewRgba } from '@/shared/geo/rasterClassification';
import {
  buildRasterValidityMask,
  loadRasterMetadata,
  normalizeNoDataValue,
  openRasterSession,
} from '@/shared/geo/rasterIo';
import {
  buildPreviewRgba,
  calculatePreviewDimensions,
  countExtraSamples,
  extractInterleavedBand,
  getSampleRanges,
  resolveDataBandCount,
} from '@/shared/geo/rasterPreview';
import type { RasterWorkerRequest, RasterWorkerResponse } from '@/shared/types/raster';

export type RasterWorkerTaskResult = {
  response: RasterWorkerResponse;
  transfer: Transferable[];
};

/**
 * Worker 任务实现（与线程包装分离，便于直接做单元测试）。
 *
 * 支持任务：
 * 1. recolor-preview：单波段影像分类重着色
 * 2. aggregate-grid：解码围栏窗口（按窗口缓存）并做网格聚合
 * 3. load-preview：读取并构建影像预览（含 RGBA 与采样数据）
 * 4. load-validity-mask：读取并构建有效像元掩膜
 */
export async function handleRasterWorkerRequest(
  request: RasterWorkerRequest,
): Promise<RasterWorkerTaskResult> {
  if (request.type === 'recolor-preview') {
    const { width, height, sampleData, noDataValue, layer } = request.payload;
    const rgba = buildRasterClassificationPreviewRgba(sampleData, width, height, layer, noDataValue);
    const response: RasterWorkerResponse = {
      id: request.id,
      type: 'recolor-preview',
      result: {
        rgbaBuffer: rgba.buffer as ArrayBuffer,
        width,
        height,
      },
    };

    return { response, transfer: [rgba.buffer as Transferable] };
  }

  if (request.type === 'aggregate-grid') {
    const {
      source,
      sourceKey,
      fenceRings,
      samples,
      metricTransformDescriptor,
      gridCellWidth,
      gridCellHeight,
      aggregationMode,
      rotationDeg,
    } = request.payload;

    // 解码与聚合都留在 Worker 内，解码结果按窗口缓存，
    // 网格尺寸/旋转/聚合模式变化时不会重新解码，也不需要把波段转移出线程。
    const fenceWindow = await readFenceWindowWithCache({ source, sourceKey, fenceRings, samples });
    const primaryBand = fenceWindow.bands[0];

    if (!primaryBand) {
      throw new Error('GeoTIFF 缺少主波段数据');
    }

    const result = aggregateGridCellsFromRasterWindow({
      fenceRings,
      window: fenceWindow.window,
      width: fenceWindow.width,
      height: fenceWindow.height,
      origin: fenceWindow.origin,
      resolution: fenceWindow.resolution,
      band: primaryBand,
      noDataValue: fenceWindow.sourceNoDataValue,
      metricTransform: metricTransformDescriptor
        ? createMetricTransformFromDescriptor(metricTransformDescriptor)
        : undefined,
      gridCellWidth,
      gridCellHeight,
      aggregationMode,
      rotationDeg,
    });

    const response: RasterWorkerResponse = {
      id: request.id,
      type: 'aggregate-grid',
      result,
    };

    return { response, transfer: [] };
  }

  if (request.type === 'load-preview') {
    const { source, sourceKey, maxEdge } = request.payload;
    const image = await openRasterSession(source, { cacheKey: sourceKey }).getImage();
    const noDataValue = normalizeNoDataValue(image.getGDALNoData?.() ?? image.fileDirectory?.GDAL_NODATA);
    const previewSize = calculatePreviewDimensions(image.getWidth(), image.getHeight(), maxEdge);
    const samplesPerPixel = image.getSamplesPerPixel();
    // 与主线程路径保持一致：排除尾部附加波段（处方波段）
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

    const rgba = buildPreviewRgba(
      previewSamples,
      previewSize.width,
      previewSize.height,
      bandCount === 2 ? 1 : bandCount,
      noDataValue,
    );

    const response: RasterWorkerResponse = {
      id: request.id,
      type: 'load-preview',
      result: {
        rgbaBuffer: rgba.buffer as ArrayBuffer,
        width: previewSize.width,
        height: previewSize.height,
        sampleBandCount: bandCount,
        classificationBandCount,
        sampleData: Float32Array.from(samples as ArrayLike<number>),
        sampleRanges: getSampleRanges(samples as ArrayLike<number>, bandCount, noDataValue),
        noDataValue,
      },
    };

    return {
      response,
      transfer: [rgba.buffer as Transferable, response.result.sampleData.buffer as Transferable],
    };
  }

  if (request.type === 'load-validity-mask') {
    const { source, sourceKey } = request.payload;
    const image = await openRasterSession(source, { cacheKey: sourceKey }).getImage();
    const validityMask = await buildRasterValidityMask(image);

    const response: RasterWorkerResponse = {
      id: request.id,
      type: 'load-validity-mask',
      result: validityMask,
    };

    return { response, transfer: [validityMask.data.buffer as Transferable] };
  }

  if (request.type === 'load-metadata') {
    const { source } = request.payload;
    const metadata = await loadRasterMetadata(source);
    const { metricTransform, ...rest } = metadata;

    const response: RasterWorkerResponse = {
      id: request.id,
      type: 'load-metadata',
      result: { ...rest, metricTransformDescriptor: metricTransform.descriptor },
    };

    return { response, transfer: [] };
  }

  if (request.type === 'read-embedded-snapshot') {
    const { source } = request.payload;
    const result = await readEmbeddedProjectSnapshotWithSession(source);

    const response: RasterWorkerResponse = {
      id: request.id,
      type: 'read-embedded-snapshot',
      result,
    };

    return { response, transfer: [] };
  }

  if (request.type === 'export-geotiff') {
    const { source, fenceRings, gridCellSize, aggregationMode, filename, activeClassificationLayer, metricTransformDescriptor, rotationDeg, projectSnapshot } = request.payload;
    const result = await buildGeoTiffExportBytes({
      file: source,
      fenceRings,
      gridCellSize,
      aggregationMode,
      filename,
      activeClassificationLayer,
      metricTransform: metricTransformDescriptor
        ? createMetricTransformFromDescriptor(metricTransformDescriptor)
        : null,
      rotationDeg,
      projectSnapshot,
    });

    const response: RasterWorkerResponse = {
      id: request.id,
      type: 'export-geotiff',
      result,
    };

    return { response, transfer: [result.bytes as Transferable] };
  }

  return {
    response: {
      id: (request as RasterWorkerRequest).id,
      type: 'error',
      error: `未知 worker 任务类型: ${(request as { type?: string }).type}`,
    },
    transfer: [],
  };
}
