/// <reference lib="webworker" />

import { buildRasterClassificationPreviewRgba } from '@/shared/geo/rasterClassification';
import { aggregateGridCellsFromRasterWindow } from '@/shared/geo/gridAggregation';
import {
  buildRasterValidityMask,
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

/**
 * Web Worker：在后台线程执行纯栅格计算，避免阻塞主线程。
 * 支持任务：
 * 1. recolor-preview：单波段影像分类重着色
 * 2. aggregate-grid：栅格窗口网格聚合
 * 3. load-preview：读取并构建影像预览（含 RGBA 与采样数据）
 * 4. load-validity-mask：读取并构建有效像元掩膜
 */
self.onmessage = async (event: MessageEvent<RasterWorkerRequest>) => {
  const request = event.data;

  try {
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

      postMessage(response, [rgba.buffer as Transferable]);
      return;
    }

    if (request.type === 'aggregate-grid') {
      const {
        fenceRings,
        window,
        width,
        height,
        origin,
        resolution,
        band,
        noDataValue,
        metricTransform,
        gridCellWidth,
        gridCellHeight,
        aggregationMode,
        rotationDeg,
      } = request.payload;

      const result = aggregateGridCellsFromRasterWindow({
        fenceRings,
        window,
        width,
        height,
        origin,
        resolution,
        band,
        noDataValue,
        metricTransform: metricTransform ?? undefined,
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

      postMessage(response, [band.buffer as Transferable]);
      return;
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

      postMessage(response, [rgba.buffer as Transferable, response.result.sampleData.buffer as Transferable]);
      return;
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

      postMessage(response, [validityMask.data.buffer as Transferable]);
      return;
    }

    const fallbackResponse: RasterWorkerResponse = {
      id: (request as RasterWorkerRequest).id,
      type: 'error',
      error: `未知 worker 任务类型: ${(request as { type?: string }).type}`,
    };
    postMessage(fallbackResponse);
  } catch (error) {
    const errorResponse: RasterWorkerResponse = {
      id: (request as RasterWorkerRequest).id,
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
    postMessage(errorResponse);
  }
};
