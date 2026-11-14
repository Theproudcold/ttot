/// <reference lib="webworker" />

import { handleRasterWorkerRequest } from '@/shared/workers/rasterWorkerTasks';
import type { RasterWorkerRequest, RasterWorkerResponse } from '@/shared/types/raster';

/**
 * Web Worker 线程包装：只负责收发消息，具体任务实现在 rasterWorkerTasks 中
 * （那部分不依赖 worker 全局，因此可以直接跑单元测试）。
 */
self.onmessage = async (event: MessageEvent<RasterWorkerRequest>) => {
  const request = event.data;

  try {
    const { response, transfer } = await handleRasterWorkerRequest(request);
    postMessage(response, transfer);
  } catch (error) {
    const errorResponse: RasterWorkerResponse = {
      id: request.id,
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
    postMessage(errorResponse);
  }
};
