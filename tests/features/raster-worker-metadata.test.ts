import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fromArrayBufferMock, imageState } = vi.hoisted(() => ({
  fromArrayBufferMock: vi.fn(),
  imageState: {
    imageDescription: null as string | null,
  },
}));

vi.mock('geotiff', () => ({
  fromArrayBuffer: fromArrayBufferMock,
}));

import { encodeEmbeddedSnapshot, exportProjectSnapshot } from '@/features/project/projectSnapshot';
import { createMetricTransform } from '@/shared/geo/crs';
import { resetRasterSessionCache } from '@/shared/geo/rasterIo';
import { rebuildRasterMetadata } from '@/shared/workers/rasterWorkerRequests';
import { handleRasterWorkerRequest } from '@/shared/workers/rasterWorkerTasks';
import type { RasterWorkerResponse } from '@/shared/types/raster';

const BOUNDING_BOX: [number, number, number, number] = [119.420001, 36.510001, 119.420901, 36.510601];

function makeFile(): File {
  const file = new File([new Uint8Array([1, 2, 3])], 'demo.tif', { type: 'image/tiff' });
  Object.defineProperty(file, 'lastModified', { value: 1_700_000_000_000 });
  return file;
}

function makeImage() {
  return {
    getWidth: () => 2,
    getHeight: () => 2,
    getBoundingBox: () => BOUNDING_BOX,
    getOrigin: () => [119.420001, 36.510601, 0] as [number, number, number],
    getResolution: () => [0.00045, -0.0003, 0] as [number, number, number],
    getGeoKeys: () => ({ ProjectedCSTypeGeoKey: 4549 }),
    getSamplesPerPixel: () => 1,
    getGDALNoData: () => null,
    getBitsPerSample: () => 32,
    getSampleFormat: () => 3,
    getFileDirectory: () =>
      imageState.imageDescription ? { ImageDescription: imageState.imageDescription } : {},
    readRasters: vi.fn(async () => [new Float32Array([1, 2, 3, 4])]),
  };
}

function makeSnapshot() {
  return exportProjectSnapshot({
    sourceFile: null,
    sourceLabel: '未选择文件',
    metadata: null,
    fenceRings: [
      [
        [0, 0],
        [3, 0],
        [3, 3],
        [0, 3],
        [0, 0],
      ],
    ],
    grid: { cellSize: 1.5, rotation: 12, aggregationMode: 'min' },
    classification: {
      layers: [
        {
          id: 'rules-a',
          label: '规则方案',
          noDataColor: '#00000000',
          visible: true,
          mode: 'rules',
          gradientStops: [],
          rules: [{ min: 0, max: null, color: '#226622', label: '高值', applicationRate: 8 }],
        },
      ],
      activeLayerId: 'rules-a',
      visibleLayerId: 'rules-a',
    },
    view: {
      layers: { raster: true, fence: true, grid: true },
      gridRenderSettings: {
        useClassificationColors: true,
        fillColor: '#3388ff',
        fillOpacity: 0.3,
        strokeColor: '#3388ff',
        strokeOpacity: 0.8,
        strokeWidth: 1,
      },
    },
  });
}

describe('rasterWorkerTasks: load-metadata', () => {
  beforeEach(() => {
    imageState.imageDescription = null;
    fromArrayBufferMock.mockReset();
    fromArrayBufferMock.mockResolvedValue({ getImage: vi.fn().mockResolvedValue(makeImage()) });
    resetRasterSessionCache();
  });

  it('返回可克隆的元信息，主线程重建出的度量变换与直接创建一致', async () => {
    const { response } = await handleRasterWorkerRequest({
      id: 'meta-1',
      type: 'load-metadata',
      payload: { source: makeFile() },
    });

    expect(response.type).toBe('load-metadata');
    if (response.type !== 'load-metadata') {
      throw new Error('unexpected response type');
    }

    // 度量变换含函数，能过结构化克隆说明传的是描述而不是变换对象
    const payload = structuredClone(response.result);
    const metadata = rebuildRasterMetadata(payload);

    expect(metadata.width).toBe(2);
    expect(metadata.height).toBe(2);
    expect(metadata.crsCode).toBe('EPSG:4549');
    expect('metricTransformDescriptor' in metadata).toBe(false);

    // 与主线程直接创建的同参变换逐点一致
    const direct = createMetricTransform({ crsCode: 'EPSG:4549', boundingBox: BOUNDING_BOX });
    expect(metadata.metricTransform.metricExtent).toEqual(direct.metricExtent);
    expect(metadata.metricTransform.toMetric([119.42045, 36.5103])).toEqual(
      direct.toMetric([119.42045, 36.5103]),
    );
  });
});

describe('rasterWorkerTasks: read-embedded-snapshot', () => {
  beforeEach(() => {
    imageState.imageDescription = null;
    fromArrayBufferMock.mockReset();
    fromArrayBufferMock.mockResolvedValue({ getImage: vi.fn().mockResolvedValue(makeImage()) });
    resetRasterSessionCache();
  });

  function snapshotResponse(response: RasterWorkerResponse) {
    expect(response.type).toBe('read-embedded-snapshot');
    if (response.type !== 'read-embedded-snapshot') {
      throw new Error('unexpected response type');
    }

    return response.result;
  }

  it('在 Worker 内解出本工具内嵌的配方', async () => {
    const snapshot = makeSnapshot();
    imageState.imageDescription = `${encodeEmbeddedSnapshot(snapshot)}\0`;

    const { response } = await handleRasterWorkerRequest({
      id: 'snapshot-1',
      type: 'read-embedded-snapshot',
      payload: { source: makeFile() },
    });
    const result = snapshotResponse(response);

    expect(result?.ok).toBe(true);
    if (!result || !result.ok) {
      return;
    }
    expect(result.snapshot).toEqual(snapshot);
  });

  it('第三方 GeoTIFF 返回 null 而不是报错', async () => {
    imageState.imageDescription = 'GDAL 3.9.0, released 2024/05/07';

    const { response } = await handleRasterWorkerRequest({
      id: 'snapshot-2',
      type: 'read-embedded-snapshot',
      payload: { source: makeFile() },
    });

    expect(snapshotResponse(response)).toBeNull();
  });
});
