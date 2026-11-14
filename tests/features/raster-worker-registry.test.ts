import { beforeEach, describe, expect, it } from 'vitest';

import {
  getRasterWorker,
  registerRasterWorker,
  unregisterRasterWorker,
} from '@/shared/workers/rasterWorkerRegistry';

type Handler = (event: unknown) => void;

function makeWorker() {
  const handlers = new Map<string, Set<Handler>>();

  const worker = {
    addEventListener(type: string, handler: Handler) {
      const set = handlers.get(type) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(type, set);
    },
    removeEventListener(type: string, handler: Handler) {
      handlers.get(type)?.delete(handler);
    },
    dispatch(type: string, event: unknown = {}) {
      for (const handler of [...(handlers.get(type) ?? [])]) {
        handler(event);
      }
    },
  };

  return worker as unknown as Worker & { dispatch: (type: string, event?: unknown) => void };
}

describe('rasterWorkerRegistry', () => {
  let mapWorker: ReturnType<typeof makeWorker>;
  let loaderWorker: ReturnType<typeof makeWorker>;

  beforeEach(() => {
    mapWorker = makeWorker();
    loaderWorker = makeWorker();
  });

  it('优先返回 map 侧 Worker（它持有围栏窗口缓存）', () => {
    registerRasterWorker('loader', loaderWorker);
    expect(getRasterWorker()).toBe(loaderWorker);

    registerRasterWorker('map', mapWorker);
    expect(getRasterWorker()).toBe(mapWorker);

    unregisterRasterWorker('map', mapWorker);
    unregisterRasterWorker('loader', loaderWorker);
  });

  it('Worker 报错后自动注销，后续请求回退主线程而不是打给死实例', () => {
    registerRasterWorker('map', mapWorker);
    expect(getRasterWorker()).toBe(mapWorker);

    mapWorker.dispatch('error');

    expect(getRasterWorker()).toBeNull();
  });

  it('只注销传入的那个实例，不影响同类别的新实例', () => {
    registerRasterWorker('map', mapWorker);
    registerRasterWorker('map', loaderWorker);

    unregisterRasterWorker('map', mapWorker);

    expect(getRasterWorker()).toBe(loaderWorker);
    unregisterRasterWorker('map', loaderWorker);
  });

  it('未注册时返回 null', () => {
    expect(getRasterWorker()).toBeNull();
  });
});
