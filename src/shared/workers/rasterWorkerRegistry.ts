import type { RasterWorkerRequest, RasterWorkerResponse } from '@/shared/types/raster';

export type RasterWorkerKind = 'map' | 'loader';

/**
 * 拉取顺序：map 侧 Worker 持有围栏窗口解码缓存，优先复用，
 * 这样「调完网格直接导出」可以省掉一次整窗解码。
 */
const PREFERRED_ORDER: RasterWorkerKind[] = ['map', 'loader'];

const workers = new Map<RasterWorkerKind, Worker>();
let jobSequence = 0;

export function registerRasterWorker(kind: RasterWorkerKind, worker: Worker): void {
  workers.set(kind, worker);

  // Worker 崩溃后不能继续被复用：出错即注销，后续请求走主线程回退，
  // 否则会给一个死实例 postMessage 并一直等到超时。
  worker.addEventListener(
    'error',
    () => {
      unregisterRasterWorker(kind, worker);
    },
    { once: true },
  );
}

export function unregisterRasterWorker(kind: RasterWorkerKind, worker: Worker): void {
  if (workers.get(kind) === worker) {
    workers.delete(kind);
  }
}

/**
 * 取一个可用的 Worker。组件销毁后注册会被注销，因此这里可能返回 null（调用方需回退主线程）。
 */
export function getRasterWorker(): Worker | null {
  for (const kind of PREFERRED_ORDER) {
    const worker = workers.get(kind);
    if (worker) {
      return worker;
    }
  }

  return null;
}

export function createRasterWorkerJobId(): string {
  jobSequence += 1;
  return `raster-job-${jobSequence}`;
}

/**
 * 向 Worker 发一个请求并等待对应 id 的响应。
 */
export function requestRasterWorker<T extends Exclude<RasterWorkerResponse['type'], 'error'>>(
  worker: Worker,
  request: RasterWorkerRequest,
  timeoutMs = 60000,
): Promise<Extract<RasterWorkerResponse, { type: T }>> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      clearTimeout(timeout);
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
    };

    const handleMessage = (event: MessageEvent<RasterWorkerResponse>) => {
      const response = event.data;
      if (response.id !== request.id) {
        return;
      }

      cleanup();

      if (response.type === 'error') {
        reject(new Error(response.error));
        return;
      }

      resolve(response as Extract<RasterWorkerResponse, { type: T }>);
    };

    const handleError = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(`Worker error: ${event.message}`));
    };

    timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Worker request timeout'));
    }, timeoutMs);

    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError);
    worker.postMessage(request);
  });
}
