import { useEffect, useRef } from 'react';

import {
  debugLog,
  markPerformanceEnd,
  markPerformanceStart,
  summarizePreviewPayload,
} from '@/features/map/debugLogger';
import {
  buildRasterSourceKey,
  loadRasterMetadata,
  loadRasterPreview,
  loadRasterValidityMask,
} from '@/shared/geo/raster';
import { createPreviewDataUrl } from '@/shared/geo/rasterPreview';
import type { RasterPreview, RasterWorkerRequest, RasterWorkerResponse } from '@/shared/types/raster';

import { useRasterStore } from './rasterStore';

type RasterLoaderOptions = {
  enabled?: boolean;
};

const MAX_PREVIEW_EDGE = 1024;

function postWorkerRequest<T extends Exclude<RasterWorkerResponse['type'], 'error'>>
(
  worker: Worker,
  request: RasterWorkerRequest,
): Promise<Extract<RasterWorkerResponse, { type: T }>> {
  return new Promise((resolve, reject) => {
    const handleMessage = (event: MessageEvent<RasterWorkerResponse>) => {
      const response = event.data;
      if (response.id !== request.id) return;
      clearTimeout(timeout);
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      if (response.type === 'error') {
        reject(new Error(response.error));
      } else {
        resolve(response as Extract<RasterWorkerResponse, { type: T }>);
      }
    };
    const handleError = (event: ErrorEvent) => {
      clearTimeout(timeout);
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      reject(new Error(`Worker error: ${event.message}`));
    };
    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError);
    const timeout = setTimeout(() => {
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      reject(new Error('Worker request timeout'));
    }, 60000);
    worker.postMessage(request);
  });
}

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

  const workerRef = useRef<Worker | null>(null);
  const previewJobIdRef = useRef(0);
  const maskJobIdRef = useRef(0);

  useEffect(() => {
    if (import.meta.env.VITEST) {
      return;
    }
    const worker = new Worker(
      new URL('../../shared/workers/rasterCompute.worker.ts', import.meta.url),
      { type: 'module' },
    );
    worker.onerror = (error) => {
      debugLog('loader', 'Worker 全局错误', error);
    };
    workerRef.current = worker;
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

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

    const worker = workerRef.current;

    // 同一个 File 发给 Worker 后会被结构化克隆成新对象，按对象身份缓存必然失效；
    // 用内容指纹作键，让预览与有效掩膜两次请求复用同一个解析会话。
    const sourceKey = buildRasterSourceKey(sourceFile);

    const loadPreviewViaWorker = async (): Promise<RasterPreview> => {
      if (!worker) {
        throw new Error('Worker not available');
      }
      previewJobIdRef.current += 1;
      const request: RasterWorkerRequest = {
        id: `preview-${previewJobIdRef.current}`,
        type: 'load-preview',
        payload: {
          source: sourceFile,
          sourceKey,
          maxEdge: MAX_PREVIEW_EDGE,
        },
      };
      const response = await postWorkerRequest(worker, request);
      if (response.type !== 'load-preview') {
        throw new Error('Unexpected worker response type');
      }
      if (!disposed) {
        setLoadingProgress('正在合成预览图', 90);
      }
      const url = createPreviewDataUrl(
        response.result.width,
        response.result.height,
        new Uint8ClampedArray(response.result.rgbaBuffer),
      );
      return {
        url,
        width: response.result.width,
        height: response.result.height,
        sampleBandCount: response.result.sampleBandCount,
        classificationBandCount: response.result.classificationBandCount,
        sampleData: response.result.sampleData,
        sampleRanges: response.result.sampleRanges,
        noDataValue: response.result.noDataValue,
      };
    };

    const loadPreview = async () => {
      try {
        let nextPreview: RasterPreview;
        if (worker) {
          try {
            nextPreview = await loadPreviewViaWorker();
          } catch (workerError) {
            debugLog('loader', 'Worker 预览生成失败，回退主线程', workerError);
            // 回退路径也必须用同一个 maxEdge，否则预览尺寸/采样与 Worker 路径不一致
            nextPreview = await loadRasterPreview(
              sourceFile,
              (progress, phase) => {
                if (!disposed) {
                  setLoadingProgress(phase, progress);
                }
              },
              { maxEdge: MAX_PREVIEW_EDGE },
            );
          }
        } else {
          nextPreview = await loadRasterPreview(
            sourceFile,
            (progress, phase) => {
              if (!disposed) {
                setLoadingProgress(phase, progress);
              }
            },
            { maxEdge: MAX_PREVIEW_EDGE },
          );
        }
        if (!disposed) {
          setPreview(nextPreview);
          setLoadingProgress('预览已就绪', 100);
          debugLog('loader', '预览生成完成', summarizePreviewPayload(nextPreview));
        }
      } catch (error) {
        if (!disposed) {
          const errorDetail = error instanceof Error
            ? { message: error.message, stack: error.stack }
            : error;
          debugLog('loader', '预览生成失败', errorDetail);
          console.error('[GeoTIFF] 预览生成失败:', error);
          setPreviewStatus('error');
        }
      } finally {
        markPerformanceEnd('raster:preview');
      }
    };

    loadPreview();

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

    const worker = workerRef.current;

    const loadMaskViaWorker = async () => {
      if (!worker) {
        throw new Error('Worker not available');
      }
      maskJobIdRef.current += 1;
      const request: RasterWorkerRequest = {
        id: `mask-${maskJobIdRef.current}`,
        type: 'load-validity-mask',
        payload: {
          source: sourceFile,
          // 与预览请求共用同一个会话，避免把整幅影像再读再解析一遍
          sourceKey: buildRasterSourceKey(sourceFile),
        },
      };
      const response = await postWorkerRequest(worker, request);
      if (response.type !== 'load-validity-mask') {
        throw new Error('Unexpected worker response type');
      }
      return response.result;
    };

    const loadMask = async () => {
      try {
        let nextValidityMask: Awaited<ReturnType<typeof loadRasterValidityMask>>;
        if (worker) {
          try {
            nextValidityMask = await loadMaskViaWorker();
          } catch (workerError) {
            debugLog('loader', 'Worker 有效区域提取失败，回退主线程', workerError);
            nextValidityMask = await loadRasterValidityMask(sourceFile, () => undefined);
          }
        } else {
          nextValidityMask = await loadRasterValidityMask(sourceFile, () => undefined);
        }
        if (!disposed) {
          setValidityMask(nextValidityMask);
          setValidityStatus('ready');
          debugLog('loader', '有效区域提取完成', {
            width: nextValidityMask.width,
            height: nextValidityMask.height,
            boundingBox: nextValidityMask.boundingBox,
          });
        }
      } catch (error) {
        if (!disposed) {
          debugLog('loader', '有效区域提取失败', error);
          setValidityStatus('error');
        }
      } finally {
        markPerformanceEnd('raster:validity-mask');
      }
    };

    loadMask();

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
