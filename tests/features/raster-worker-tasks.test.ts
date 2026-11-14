import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fromArrayBufferMock, imageState } = vi.hoisted(() => ({
  fromArrayBufferMock: vi.fn(),
  imageState: {
    width: 2,
    height: 2,
    origin: [119.420001, 36.510601, 0] as [number, number, number],
    resolution: [0.00045, -0.0003, 0] as [number, number, number],
    noData: null as unknown,
    band: new Float32Array([1, 3, 5, 7]),
    readRastersCalls: 0,
  },
}));

vi.mock('geotiff', () => ({
  fromArrayBuffer: fromArrayBufferMock,
}));

import { createMetricTransform } from '@/shared/geo/crs';
import { resetFenceWindowCache } from '@/shared/geo/fenceWindow';
import { aggregateGridCellsFromRasterWindow } from '@/shared/geo/gridAggregation';
import { buildRasterSourceKey, resetRasterSessionCache } from '@/shared/geo/rasterIo';
import { handleRasterWorkerRequest } from '@/shared/workers/rasterWorkerTasks';
import { buildAggregateGridPayload } from '@/shared/workers/rasterWorkerRequests';
import type { FenceRings } from '@/shared/types/fence';
import type { RasterWorkerResponse } from '@/shared/types/raster';

const FENCE_RINGS: FenceRings = [
  [
    [119.420001, 36.510001],
    [119.420901, 36.510001],
    [119.420901, 36.510601],
    [119.420001, 36.510601],
    [119.420001, 36.510001],
  ],
];

const METRIC_TRANSFORM = createMetricTransform({
  crsCode: 'EPSG:4326',
  boundingBox: [119.420001, 36.510001, 119.420901, 36.510601],
});

function makeFile(): File {
  const file = new File([new Uint8Array([1, 2, 3])], 'demo.tif', { type: 'image/tiff' });
  Object.defineProperty(file, 'lastModified', { value: 1_700_000_000_000 });
  return file;
}

function makeImage() {
  return {
    getWidth: () => imageState.width,
    getHeight: () => imageState.height,
    getOrigin: () => imageState.origin,
    getResolution: () => imageState.resolution,
    getGDALNoData: () => imageState.noData,
    getFileDirectory: () => ({}),
    readRasters: vi.fn(async () => {
      imageState.readRastersCalls += 1;
      return [imageState.band];
    }),
  };
}

function aggregateResponse(response: RasterWorkerResponse) {
  expect(response.type).toBe('aggregate-grid');
  if (response.type !== 'aggregate-grid') {
    throw new Error('unexpected response');
  }

  return response.result;
}

describe('rasterWorkerTasks: aggregate-grid', () => {
  beforeEach(() => {
    imageState.readRastersCalls = 0;
    fromArrayBufferMock.mockReset();
    fromArrayBufferMock.mockResolvedValue({ getImage: vi.fn().mockResolvedValue(makeImage()) });
    resetRasterSessionCache();
    resetFenceWindowCache();
  });

  it('载荷可结构化克隆（曾经因为塞了含函数的 metricTransform 而必然失败）', () => {
    const file = makeFile();
    const payload = buildAggregateGridPayload({
      source: file,
      sourceKey: buildRasterSourceKey(file),
      fenceRings: FENCE_RINGS,
      metricTransform: METRIC_TRANSFORM,
      gridCellWidth: 10,
      gridCellHeight: 10,
      aggregationMode: 'mean',
      rotationDeg: 0,
    });

    expect(typeof payload.metricTransformDescriptor).toBe('object');
    expect(payload.metricTransformDescriptor?.kind).toBe('geographic');
    expect(() => structuredClone({ id: '1', type: 'aggregate-grid', payload })).not.toThrow();
  });

  it('Worker 内重建度量变换后的聚合结果与主线程完全一致', async () => {
    const file = makeFile();
    const payload = buildAggregateGridPayload({
      source: file,
      sourceKey: buildRasterSourceKey(file),
      fenceRings: FENCE_RINGS,
      metricTransform: METRIC_TRANSFORM,
      gridCellWidth: 10,
      gridCellHeight: 10,
      aggregationMode: 'mean',
      rotationDeg: 0,
    });

    // 模拟 postMessage 的结构化克隆：除 File 之外的所有字段都换成克隆后的副本
    // （Node 的 structuredClone 会把 jsdom 的 File 变成原生 Blob，jsdom 的 FileReader 不认，
    //  因此这里只克隆可克隆的其余部分，再把原 File 放回去——描述符已经真正过了一次克隆）
    const clonedPayload = {
      ...(structuredClone({ ...payload, source: null }) as object),
      source: payload.source,
    };
    const received = {
      id: 'job-1',
      type: 'aggregate-grid',
      payload: clonedPayload,
    } as Parameters<typeof handleRasterWorkerRequest>[0];
    const { response } = await handleRasterWorkerRequest(received);

    const direct = aggregateGridCellsFromRasterWindow({
      window: [0, 0, 2, 2],
      width: 2,
      height: 2,
      origin: [119.420001, 36.510601, 0],
      resolution: [0.00045, -0.0003, 0],
      fenceRings: FENCE_RINGS,
      gridCellWidth: 10,
      gridCellHeight: 10,
      band: imageState.band,
      noDataValue: null,
      metricTransform: METRIC_TRANSFORM,
      aggregationMode: 'mean',
    });

    expect(Object.keys(direct.cellsById)).toHaveLength(4);
    expect(aggregateResponse(response)).toEqual(direct);
  });

  it('同一窗口的第二次请求不再解码', async () => {
    const file = makeFile();
    const build = () =>
      buildAggregateGridPayload({
        source: file,
        sourceKey: buildRasterSourceKey(file),
        fenceRings: FENCE_RINGS,
        metricTransform: METRIC_TRANSFORM,
        gridCellWidth: 10,
        gridCellHeight: 10,
        aggregationMode: 'mean',
        rotationDeg: 0,
      });

    await handleRasterWorkerRequest({ id: 'a', type: 'aggregate-grid', payload: build() });
    await handleRasterWorkerRequest({ id: 'b', type: 'aggregate-grid', payload: build() });

    expect(imageState.readRastersCalls).toBe(1);
  });
});
