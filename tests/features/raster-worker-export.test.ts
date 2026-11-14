import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fromArrayBufferMock, imageState } = vi.hoisted(() => ({
  fromArrayBufferMock: vi.fn(),
  imageState: {
    width: 4,
    height: 4,
    noData: null as unknown,
    bands: [new Float32Array(16).fill(0), new Float32Array(16).fill(0)],
  },
}));

vi.mock('geotiff', () => ({
  fromArrayBuffer: fromArrayBufferMock,
}));

import { resetFenceWindowCache } from '@/shared/geo/fenceWindow';
import { resetRasterSessionCache } from '@/shared/geo/rasterIo';
import { buildGeoTiffExportBytes } from '@/features/export/exportGeoTiff';
import { buildExportGeoTiffPayload } from '@/shared/workers/rasterWorkerRequests';
import { handleRasterWorkerRequest } from '@/shared/workers/rasterWorkerTasks';
import type { FenceRings } from '@/shared/types/fence';
import type { RasterRuleClassificationLayer, RasterWorkerResponse } from '@/shared/types/raster';

const FENCE_RINGS: FenceRings = [
  [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
    [0, 0],
  ],
];

const LAYER: RasterRuleClassificationLayer = {
  id: 'l1',
  label: '处方',
  noDataColor: '#000000',
  mode: 'rules',
  gradientStops: [],
  rules: [
    { min: 0, max: 8, color: '#00ff00', label: '低', applicationRate: 50 },
    { min: 8, max: null, color: '#ff0000', label: '高', applicationRate: 120 },
  ],
};

function makeFile(): File {
  const file = new File([new Uint8Array([1, 2, 3])], 'demo.tif', { type: 'image/tiff' });
  Object.defineProperty(file, 'lastModified', { value: 1_700_000_000_000 });
  return file;
}

function makeImage() {
  return {
    getWidth: () => imageState.width,
    getHeight: () => imageState.height,
    getOrigin: () => [0, 4, 0] as [number, number, number],
    getResolution: () => [1, -1, 0] as [number, number, number],
    getSamplesPerPixel: () => imageState.bands.length,
    getBitsPerSample: () => 32,
    getSampleFormat: () => 3,
    getGDALNoData: () => imageState.noData,
    getFileDirectory: () => ({}),
    readRasters: vi.fn(async (options?: { samples?: number[] }) => {
      const indexes = options?.samples ?? imageState.bands.map((_band, index) => index);
      return indexes.map((index) => imageState.bands[index]);
    }),
  };
}

function exportResult(response: RasterWorkerResponse) {
  expect(response.type).toBe('export-geotiff');
  if (response.type !== 'export-geotiff') {
    throw new Error('unexpected response type');
  }

  return response.result;
}

describe('rasterWorkerTasks: export-geotiff', () => {
  beforeEach(() => {
    imageState.bands = [
      Float32Array.from({ length: 16 }, (_value, index) => index + 1),
      Float32Array.from({ length: 16 }, (_value, index) => index + 101),
    ];
    fromArrayBufferMock.mockReset();
    fromArrayBufferMock.mockResolvedValue({ getImage: vi.fn().mockResolvedValue(makeImage()) });
    resetRasterSessionCache();
    resetFenceWindowCache();
  });

  it('导出载荷可结构化克隆', () => {
    const payload = buildExportGeoTiffPayload({
      file: makeFile(),
      fenceRings: FENCE_RINGS,
      gridCellSize: 2,
      aggregationMode: 'mean',
      activeClassificationLayer: LAYER,
    });

    expect(payload.metricTransformDescriptor).toBeNull();
    expect(() => structuredClone({ id: 'x', type: 'export-geotiff', payload })).not.toThrow();
  });

  it('在 Worker 内导出的 GeoTIFF 能被读回，且处方波段按规则换算', async () => {
    const file = makeFile();
    const payload = buildExportGeoTiffPayload({
      file,
      fenceRings: FENCE_RINGS,
      gridCellSize: 2,
      aggregationMode: 'mean',
      activeClassificationLayer: LAYER,
    });

    const { response } = await handleRasterWorkerRequest({
      id: 'export-1',
      type: 'export-geotiff',
      payload: { ...payload, source: file },
    });
    const result = exportResult(response);

    expect(result.bytes.byteLength).toBeGreaterThan(0);
    expect(result.filename).toBe('demo-clipped.tif');

    // 用真实 geotiff 读回（本文件对 geotiff 做了 mock，这里取真实实现）
    const actualGeotiff = await vi.importActual<typeof import('geotiff')>('geotiff');
    const tiff = await actualGeotiff.fromArrayBuffer(result.bytes);
    const image = await tiff.getImage();

    expect(image.getWidth()).toBe(4);
    expect(image.getHeight()).toBe(4);
    // 2 个数据波段 + 1 个处方波段
    expect(image.getSamplesPerPixel()).toBe(3);

    const rasters = (await image.readRasters({ interleave: false })) as unknown as Float32Array[];
    // 主波段：每个 2x2 网格取均值
    expect(Array.from(rasters[0])).toEqual([3.5, 3.5, 5.5, 5.5, 3.5, 3.5, 5.5, 5.5, 11.5, 11.5, 13.5, 13.5, 11.5, 11.5, 13.5, 13.5]);
    // 第二波段同样按各自的网格均值改写
    expect(Array.from(rasters[1])).toEqual([103.5, 103.5, 105.5, 105.5, 103.5, 103.5, 105.5, 105.5, 111.5, 111.5, 113.5, 113.5, 111.5, 111.5, 113.5, 113.5]);
    // 处方波段：均值 < 8 的网格给 50，其余给 120
    expect(Array.from(rasters[2])).toEqual([50, 50, 50, 50, 50, 50, 50, 50, 120, 120, 120, 120, 120, 120, 120, 120]);
  });

  it('单波段影像：网格聚合解码过一次后，导出同一围栏不再解码', async () => {
    imageState.bands = [Float32Array.from({ length: 16 }, (_value, index) => index + 1)];
    const file = makeFile();
    const image = makeImage();
    fromArrayBufferMock.mockResolvedValue({ getImage: vi.fn().mockResolvedValue(image) });
    const readRastersSpy = image.readRasters;

    await handleRasterWorkerRequest({
      id: 'aggregate-1',
      type: 'aggregate-grid',
      payload: {
        source: file,
        fenceRings: FENCE_RINGS,
        samples: [0],
        metricTransformDescriptor: null,
        gridCellWidth: 2,
        gridCellHeight: 2,
        aggregationMode: 'mean',
        rotationDeg: 0,
      },
    });
    expect(readRastersSpy).toHaveBeenCalledTimes(1);

    // 单波段时「全部波段」就是 [0]，与聚合请求命中同一份窗口缓存
    const { response } = await handleRasterWorkerRequest({
      id: 'export-1',
      type: 'export-geotiff',
      payload: {
        source: file,
        fenceRings: FENCE_RINGS,
        gridCellSize: 2,
        aggregationMode: 'mean',
        activeClassificationLayer: null,
        metricTransformDescriptor: null,
        rotationDeg: 0,
      },
    });

    expect(exportResult(response).bytes.byteLength).toBeGreaterThan(0);
    expect(readRastersSpy).toHaveBeenCalledTimes(1);
  });
});

describe('导出与窗口缓存的交互', () => {
  beforeEach(() => {
    imageState.bands = [Float32Array.from({ length: 16 }, (_value, index) => index + 1)];
    fromArrayBufferMock.mockReset();
    fromArrayBufferMock.mockResolvedValue({ getImage: vi.fn().mockResolvedValue(makeImage()) });
    resetRasterSessionCache();
    resetFenceWindowCache();
  });

  it('同一围栏连续导出两次都成功：导出不得清空缓存中的源波段', async () => {
    const file = makeFile();
    const input = { file, fenceRings: FENCE_RINGS, gridCellSize: 2, aggregationMode: 'mean' as const };

    const first = await buildGeoTiffExportBytes(input);
    expect(first.bytes.byteLength).toBeGreaterThan(0);

    // 第二次会命中围栏窗口缓存；若导出清空了缓存里的 bands，这里会抛「导出需要至少一个波段」
    const second = await buildGeoTiffExportBytes(input);
    expect(second.bytes.byteLength).toBeGreaterThan(0);
  });

  it('导出之后同一窗口的聚合仍然可用', async () => {
    const file = makeFile();
    await buildGeoTiffExportBytes({ file, fenceRings: FENCE_RINGS, gridCellSize: 2, aggregationMode: 'mean' });

    const { response } = await handleRasterWorkerRequest({
      id: 'aggregate-after-export',
      type: 'aggregate-grid',
      payload: {
        source: file,
        fenceRings: FENCE_RINGS,
        samples: [0],
        metricTransformDescriptor: null,
        gridCellWidth: 2,
        gridCellHeight: 2,
        aggregationMode: 'mean',
        rotationDeg: 0,
      },
    });

    expect(response.type).toBe('aggregate-grid');
    if (response.type === 'aggregate-grid') {
      expect(Object.keys(response.result.cellsById).length).toBeGreaterThan(0);
    }
  });
});
