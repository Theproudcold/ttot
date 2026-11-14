import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fromArrayBufferMock, imageState } = vi.hoisted(() => ({
  fromArrayBufferMock: vi.fn(),
  imageState: {
    width: 10,
    height: 10,
    origin: [0, 0] as [number, number],
    resolution: [1, -1] as [number, number],
    noData: null as unknown,
    readRastersCalls: [] as Array<{ window?: number[]; samples?: number[] }>,
  },
}));

vi.mock('geotiff', () => ({
  fromArrayBuffer: fromArrayBufferMock,
}));

import { readFenceWindowWithCache, resetFenceWindowCache } from '@/shared/geo/fenceWindow';
import { buildRasterSourceKey, resetRasterSessionCache } from '@/shared/geo/rasterIo';
import type { FenceRings } from '@/shared/types/fence';

function makeFile(name: string, lastModified = 1_700_000_000_000): File {
  const file = new File([new Uint8Array([1, 2, 3])], name, { type: 'image/tiff' });
  Object.defineProperty(file, 'lastModified', { value: lastModified });
  return file;
}

function rectangle(x0: number, y0: number, x1: number, y1: number): FenceRings {
  return [
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
      [x0, y0],
    ],
  ];
}

const FENCE_A = rectangle(2, -8, 8, -2);
const FENCE_B = rectangle(3, -7, 7, -3);
const FENCE_C = rectangle(1, -9, 9, -1);

function makeImage() {
  return {
    getWidth: () => imageState.width,
    getHeight: () => imageState.height,
    getOrigin: () => imageState.origin,
    getResolution: () => imageState.resolution,
    getGDALNoData: () => imageState.noData,
    getFileDirectory: () => ({}),
    readRasters: vi.fn(async (options: { window?: number[]; samples?: number[] }) => {
      imageState.readRastersCalls.push({ window: options.window, samples: options.samples });
      return [new Float32Array([1, 2, 3, 4])];
    }),
  };
}

const decodeCount = () => imageState.readRastersCalls.length;

describe('readFenceWindowWithCache', () => {
  beforeEach(() => {
    imageState.readRastersCalls = [];
    imageState.noData = null;
    fromArrayBufferMock.mockReset();
    fromArrayBufferMock.mockResolvedValue({ getImage: vi.fn().mockResolvedValue(makeImage()) });
    resetRasterSessionCache();
    resetFenceWindowCache();
  });

  it('同一围栏重复读取只解码一次', async () => {
    const file = makeFile('demo.tif');
    const sourceKey = buildRasterSourceKey(file);

    const first = await readFenceWindowWithCache({ source: file, sourceKey, fenceRings: FENCE_A, samples: [0] });
    const second = await readFenceWindowWithCache({ source: file, sourceKey, fenceRings: FENCE_A, samples: [0] });

    // 这正是网格尺寸/旋转/聚合模式变化时的路径：窗口没变就不该重新解码
    expect(decodeCount()).toBe(1);
    expect(second).toBe(first);
  });

  it('围栏外接框变化时重新解码并更新窗口', async () => {
    const file = makeFile('demo.tif');
    const sourceKey = buildRasterSourceKey(file);

    await readFenceWindowWithCache({ source: file, sourceKey, fenceRings: FENCE_A, samples: [0] });
    await readFenceWindowWithCache({ source: file, sourceKey, fenceRings: FENCE_B, samples: [0] });

    expect(decodeCount()).toBe(2);
    expect(imageState.readRastersCalls[0].window).toEqual([2, 2, 8, 8]);
    expect(imageState.readRastersCalls[1].window).toEqual([3, 3, 7, 7]);
  });

  it('不同影像源不共享缓存', async () => {
    const first = makeFile('demo.tif');
    const second = makeFile('other.tif');

    await readFenceWindowWithCache({
      source: first,
      sourceKey: buildRasterSourceKey(first),
      fenceRings: FENCE_A,
      samples: [0],
    });
    await readFenceWindowWithCache({
      source: second,
      sourceKey: buildRasterSourceKey(second),
      fenceRings: FENCE_A,
      samples: [0],
    });

    expect(decodeCount()).toBe(2);
  });

  it('不同波段组合不共享缓存', async () => {
    const file = makeFile('demo.tif');
    const sourceKey = buildRasterSourceKey(file);

    await readFenceWindowWithCache({ source: file, sourceKey, fenceRings: FENCE_A, samples: [0] });
    await readFenceWindowWithCache({ source: file, sourceKey, fenceRings: FENCE_A, samples: [0, 1] });

    expect(decodeCount()).toBe(2);
    expect(imageState.readRastersCalls[0].samples).toEqual([0]);
    expect(imageState.readRastersCalls[1].samples).toEqual([0, 1]);
  });

  it('缺省波段为 [0]', async () => {
    const file = makeFile('demo.tif');

    await readFenceWindowWithCache({ source: file, fenceRings: FENCE_A });

    expect(imageState.readRastersCalls[0].samples).toEqual([0]);
  });

  it('只保留最近两个窗口，被淘汰的窗口再次请求会重新解码', async () => {
    const file = makeFile('demo.tif');
    const sourceKey = buildRasterSourceKey(file);

    await readFenceWindowWithCache({ source: file, sourceKey, fenceRings: FENCE_A, samples: [0] });
    await readFenceWindowWithCache({ source: file, sourceKey, fenceRings: FENCE_B, samples: [0] });
    await readFenceWindowWithCache({ source: file, sourceKey, fenceRings: FENCE_C, samples: [0] });
    expect(decodeCount()).toBe(3);

    // A 已被淘汰 → 重新解码；C 仍在缓存 → 命中
    await readFenceWindowWithCache({ source: file, sourceKey, fenceRings: FENCE_A, samples: [0] });
    expect(decodeCount()).toBe(4);
    await readFenceWindowWithCache({ source: file, sourceKey, fenceRings: FENCE_C, samples: [0] });
    expect(decodeCount()).toBe(4);

    // 命中后 C 成为最近使用，B 被淘汰
    await readFenceWindowWithCache({ source: file, sourceKey, fenceRings: FENCE_B, samples: [0] });
    expect(decodeCount()).toBe(5);
  });

  it('resetFenceWindowCache 之后重新解码', async () => {
    const file = makeFile('demo.tif');

    await readFenceWindowWithCache({ source: file, fenceRings: FENCE_A });
    resetFenceWindowCache();
    await readFenceWindowWithCache({ source: file, fenceRings: FENCE_A });

    expect(decodeCount()).toBe(2);
  });

  it('返回窗口尺寸与归一化后的 nodata', async () => {
    imageState.noData = '-9999';
    const file = makeFile('demo.tif');

    const result = await readFenceWindowWithCache({ source: file, fenceRings: FENCE_A, samples: [0] });

    expect(result.window).toEqual([2, 2, 8, 8]);
    expect(result.width).toBe(6);
    expect(result.height).toBe(6);
    expect(result.sourceNoDataValue).toBe(-9999);
    expect(result.bands[0]).toBeInstanceOf(Float32Array);
  });

  it('围栏完全落在影像外时抛出与导出路径一致的错误', async () => {
    const file = makeFile('demo.tif');

    await expect(
      readFenceWindowWithCache({ source: file, fenceRings: rectangle(20, -30, 30, -20) }),
    ).rejects.toThrow('围栏超出影像范围');
    expect(decodeCount()).toBe(0);
  });
});
