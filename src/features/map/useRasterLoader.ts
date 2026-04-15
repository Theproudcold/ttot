import { useEffect } from 'react';

import {
  debugLog,
  markPerformanceEnd,
  markPerformanceStart,
  summarizePreviewPayload,
} from '@/features/map/debugLogger';
import { loadRasterMetadata, loadRasterPreview, loadRasterValidityMask } from '@/shared/geo/raster';

import { useRasterStore } from './rasterStore';

type RasterLoaderOptions = {
  enabled?: boolean;
};

export function useRasterLoader(options?: RasterLoaderOptions) {
  const enabled = options?.enabled ?? !import.meta.env.VITEST;
  const sourceFile = useRasterStore((state) => state.sourceFile);
  const sourceId = useRasterStore((state) => state.sourceId);
  const metadata = useRasterStore((state) => state.metadata);
  const preview = useRasterStore((state) => state.preview);
  const previewStatus = useRasterStore((state) => state.previewStatus);
  const validityMask = useRasterStore((state) => state.validityMask);
  const setMetadata = useRasterStore((state) => state.setMetadata);
  const setPreview = useRasterStore((state) => state.setPreview);
  const setPreviewStatus = useRasterStore((state) => state.setPreviewStatus);
  const setValidityMask = useRasterStore((state) => state.setValidityMask);
  const setValidityStatus = useRasterStore((state) => state.setValidityStatus);
  const setStatus = useRasterStore((state) => state.setStatus);
  const setError = useRasterStore((state) => state.setError);
  const setLoadingProgress = useRasterStore((state) => state.setLoadingProgress);

  useEffect(() => {
    if (!enabled || !sourceFile || metadata) {
      return;
    }

    let disposed = false;
    setStatus('loading');
    setLoadingProgress('准备读取 GeoTIFF', 0);
    markPerformanceStart('raster:metadata');
    debugLog('loader', '开始读取 GeoTIFF 文件', {
      fileName: sourceFile.name,
      fileSize: sourceFile.size,
      sourceId,
    });

    loadRasterMetadata(sourceFile, (progress, phase) => {
      if (!disposed) {
        setLoadingProgress(phase, progress);
        debugLog('loader', '元信息阶段进度', {
          phase,
          progress,
          sourceId,
        });
      }
    })
      .then((nextMetadata) => {
        if (!disposed) {
          setMetadata(nextMetadata);
          debugLog('loader', 'GeoTIFF 元信息读取完成', nextMetadata);
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          debugLog('loader', 'GeoTIFF 元信息读取失败', error);
          setError(error instanceof Error ? error.message : 'GeoTIFF 加载失败');
        }
      })
      .finally(() => {
        markPerformanceEnd('raster:metadata');
      });

    return () => {
      disposed = true;
    };
  }, [enabled, metadata, setError, setLoadingProgress, setMetadata, setStatus, sourceFile, sourceId]);

  useEffect(() => {
    if (!enabled || !sourceFile || !metadata || preview) {
      return;
    }

    let disposed = false;
    setPreviewStatus('loading');
    setLoadingProgress('正在生成预览', 5);
    markPerformanceStart('raster:preview');
    debugLog('loader', '开始生成预览', {
      fileName: sourceFile.name,
      sourceId,
      metadataReady: Boolean(metadata),
    });

    loadRasterPreview(sourceFile, (progress, phase) => {
      if (!disposed) {
        setLoadingProgress(phase, progress);
        debugLog('loader', '预览阶段进度', {
          phase,
          progress,
          sourceId,
        });
      }
    })
      .then((nextPreview) => {
        if (!disposed) {
          setPreview(nextPreview);
          setLoadingProgress('预览已就绪', 100);
          debugLog('loader', '预览生成完成', summarizePreviewPayload(nextPreview));
        }
      })
      .catch((error) => {
        if (!disposed) {
          const errorDetail = error instanceof Error
            ? { message: error.message, stack: error.stack }
            : error;
          debugLog('loader', '预览生成失败', errorDetail);
          console.error('[GeoTIFF] 预览生成失败:', error);
          setPreviewStatus('error');
        }
      })
      .finally(() => {
        markPerformanceEnd('raster:preview');
      });

    return () => {
      disposed = true;
    };
  }, [
    enabled,
    metadata,
    preview,
    setLoadingProgress,
    setPreview,
    setPreviewStatus,
    sourceFile,
    sourceId,
  ]);

  useEffect(() => {
    if (!enabled || !sourceFile || !metadata || previewStatus !== 'ready' || validityMask) {
      return;
    }

    let disposed = false;
    setValidityStatus('loading');
    markPerformanceStart('raster:validity-mask');
    debugLog('loader', '开始提取有效区域', {
      fileName: sourceFile.name,
      sourceId,
    });

    loadRasterValidityMask(sourceFile, () => undefined)
      .then((nextValidityMask) => {
        if (!disposed) {
          setValidityMask(nextValidityMask);
          setValidityStatus('ready');
          debugLog('loader', '有效区域提取完成', {
            width: nextValidityMask.width,
            height: nextValidityMask.height,
            boundingBox: nextValidityMask.boundingBox,
          });
        }
      })
      .catch((error) => {
        if (!disposed) {
          debugLog('loader', '有效区域提取失败', error);
          setValidityStatus('error');
        }
      })
      .finally(() => {
        markPerformanceEnd('raster:validity-mask');
      });

    return () => {
      disposed = true;
    };
  }, [
    enabled,
    metadata,
    previewStatus,
    validityMask,
    setValidityMask,
    setValidityStatus,
    sourceFile,
    sourceId,
  ]);
}
