import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fromArrayBufferMock, readBlobBufferMock, writeGeoTiffBufferMock } = vi.hoisted(() => ({
  fromArrayBufferMock: vi.fn(),
  readBlobBufferMock: vi.fn(),
  writeGeoTiffBufferMock: vi.fn(),
}));

vi.mock('geotiff', () => ({
  fromArrayBuffer: fromArrayBufferMock,
}));

vi.mock('@/shared/geo/raster', () => ({
  readBlobBuffer: readBlobBufferMock,
  openRasterSession: (source: File) => ({
    source,
    getArrayBuffer: async () => await readBlobBufferMock(source),
    getImage: async () => {
      const arrayBuffer = await readBlobBufferMock(source);
      const tiff = await fromArrayBufferMock(arrayBuffer);
      return await tiff.getImage();
    },
  }),
}));

vi.mock('@/shared/geo/geotiffWriter', () => ({
  writeGeoTiffBuffer: writeGeoTiffBufferMock,
}));

import { exportFenceGeoTiff, downloadExportedGeoTiff } from '@/features/export/exportGeoTiff';
import {
  EMBEDDED_SNAPSHOT_PREFIX,
  encodeEmbeddedSnapshot,
  exportProjectSnapshot,
  type ExportProjectSnapshotInput,
} from '@/features/project/projectSnapshot';
import { createMetricTransform } from '@/shared/geo/crs';
import type { FenceFeature } from '@/shared/types/fence';

const fence: FenceFeature = {
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [110, 180],
        [140, 180],
        [140, 150],
        [110, 150],
        [110, 180],
      ],
    ],
  },
  summary: {
    area: 900,
    bbox: [110, 150, 140, 180],
    vertexCount: 4,
  },
};

beforeEach(() => {
  fromArrayBufferMock.mockReset();
  readBlobBufferMock.mockReset();
  writeGeoTiffBufferMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 10x10 影像桩：范围 100..200，标准 fence 恰好落在窗口 [1,2,4,5] 内 */
function stubWideImage() {
  return {
    getWidth: () => 10,
    getHeight: () => 10,
    getOrigin: () => [100, 200, 0] as [number, number, number],
    getResolution: () => [10, -10, 0] as [number, number, number],
    getGeoKeys: () => ({
      GTModelTypeGeoKey: 1,
      ProjectedCSTypeGeoKey: 4549,
    }),
    getBitsPerSample: () => 32,
    getSampleFormat: () => 3,
    getSamplesPerPixel: () => 1,
    getGDALNoData: () => null,
    getFileDirectory: () => ({
      PhotometricInterpretation: 1,
    }),
    readRasters: vi.fn().mockResolvedValue([new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9])]),
  };
}

function makeSnapshotFixture(overrides: Partial<ExportProjectSnapshotInput> = {}) {
  return exportProjectSnapshot({
    sourceFile: null,
    sourceLabel: '未选择文件',
    metadata: null,
    fenceRings: fence.geometry.coordinates,
    grid: { cellSize: 10, rotation: 0, aggregationMode: 'mean' },
    classification: { layers: [], activeLayerId: null, visibleLayerId: null },
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
    ...overrides,
  });
}

describe('exportFenceGeoTiff', () => {
  it('reads the clipped raster window and writes a new geotiff blob', async () => {
    const file = new File(['demo'], 'test2.tif', { type: 'image/tiff' });
    const image = {
      getWidth: () => 10,
      getHeight: () => 10,
      getOrigin: () => [100, 200, 0] as [number, number, number],
      getResolution: () => [10, -10, 0] as [number, number, number],
      getGeoKeys: () => ({
        GTModelTypeGeoKey: 1,
        ProjectedCSTypeGeoKey: 4549,
      }),
      getBitsPerSample: () => 32,
      getSampleFormat: () => 3,
      getSamplesPerPixel: () => 1,
      getGDALNoData: () => null,
      getFileDirectory: () => ({
        PhotometricInterpretation: 1,
        GeoKeyDirectory: new Uint16Array([1, 1, 0, 1, 3072, 0, 1, 4549]),
        GeoDoubleParams: new Float64Array([120]),
        GeoAsciiParams: 'CGCS2000|',
      }),
      readRasters: vi.fn().mockResolvedValue([new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9])]),
    };

    readBlobBufferMock.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    fromArrayBufferMock.mockResolvedValue({
      getImage: vi.fn().mockResolvedValue(image),
    });
    writeGeoTiffBufferMock.mockReturnValue(new Uint8Array([7, 8, 9]).buffer);

    const result = await exportFenceGeoTiff({
      file,
      fence,
      gridCellSize: 10,
      filename: 'test2-clipped.tif',
    });

    expect(readBlobBufferMock).toHaveBeenCalledWith(file);
    expect(fromArrayBufferMock).toHaveBeenCalledTimes(1);
    expect(image.readRasters).toHaveBeenCalledWith(
      expect.objectContaining({
        window: [1, 2, 4, 5],
        interleave: false,
      }),
    );
    expect(writeGeoTiffBufferMock).toHaveBeenCalledTimes(1);
    expect(writeGeoTiffBufferMock).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 3,
        height: 3,
        bands: expect.any(Array),
        samplesPerPixel: 1,
      }),
    );
    expect(writeGeoTiffBufferMock).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 3,
        height: 3,
        gdalNoData: undefined,
        geoKeyDirectory: new Uint16Array([1, 1, 0, 1, 3072, 0, 1, 4549]),
        geoDoubleParams: new Float64Array([120]),
        geoAsciiParams: 'CGCS2000|',
      }),
    );
    const firstCall = vi.mocked(writeGeoTiffBufferMock).mock.calls[0]?.[0];
    expect(firstCall?.bands[0]).toEqual(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(firstCall?.bitsPerSample).toEqual([32]);
    expect(firstCall?.sampleFormat).toEqual([3]);
    expect(result.filename).toBe('test2-clipped.tif');
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.blob.type).toBe('image/tiff');
  });

  it('rewrites every export band with the primary-band aggregated grid values before writing', async () => {
    const file = new File(['demo'], 'test2.tif', { type: 'image/tiff' });
    const image = {
      getWidth: () => 4,
      getHeight: () => 4,
      getOrigin: () => [100, 200, 0] as [number, number, number],
      getResolution: () => [10, -10, 0] as [number, number, number],
      getGeoKeys: () => ({
        GTModelTypeGeoKey: 1,
        ProjectedCSTypeGeoKey: 4549,
      }),
      getBitsPerSample: (index = 0) => [32, 32][index],
      getSampleFormat: (index = 0) => [3, 3][index],
      getSamplesPerPixel: () => 2,
      getGDALNoData: () => null,
      getFileDirectory: () => ({
        PhotometricInterpretation: 1,
      }),
      readRasters: vi.fn().mockResolvedValue([
        new Float32Array([1, 2, 3, 4]),
        new Float32Array([11, 12, 13, 14]),
      ]),
    };

    readBlobBufferMock.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    fromArrayBufferMock.mockResolvedValue({
      getImage: vi.fn().mockResolvedValue(image),
    });
    writeGeoTiffBufferMock.mockReturnValue(new Uint8Array([7, 8, 9]).buffer);

    await exportFenceGeoTiff({
      file,
      gridCellSize: 1,
      fence: {
        ...fence,
        summary: {
          ...fence.summary,
          bbox: [100, 160, 120, 180],
        },
        geometry: {
          ...fence.geometry,
          coordinates: [
            [
              [100, 180],
              [120, 180],
              [120, 160],
              [100, 160],
              [100, 180],
            ],
          ],
        },
      },
    });

    expect(writeGeoTiffBufferMock).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 2,
        height: 2,
        samplesPerPixel: 2,
        bands: [expect.any(Float32Array), expect.any(Float32Array)],
        gdalNoData: undefined,
      }),
    );
    const multiBandCall = vi.mocked(writeGeoTiffBufferMock).mock.calls[0]?.[0];
    expect(multiBandCall?.bands[0]).toEqual(new Float32Array([1, 2, 3, 4]));
    expect(multiBandCall?.bands[1]).toEqual(new Float32Array([1, 2, 3, 4]));
  });

  it('rewrites exported pixels to the aggregated grid mean values before writing', async () => {
    const file = new File(['demo'], 'test2.tif', { type: 'image/tiff' });
    const image = {
      getWidth: () => 4,
      getHeight: () => 4,
      getOrigin: () => [100, 200, 0] as [number, number, number],
      getResolution: () => [10, -10, 0] as [number, number, number],
      getBitsPerSample: () => 32,
      getSampleFormat: () => 3,
      getSamplesPerPixel: () => 1,
      getGDALNoData: () => null,
      getFileDirectory: () => ({
        PhotometricInterpretation: 1,
      }),
      readRasters: vi.fn().mockResolvedValue([new Float32Array([1, 3, 5, 7])]),
    };

    readBlobBufferMock.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    fromArrayBufferMock.mockResolvedValue({
      getImage: vi.fn().mockResolvedValue(image),
    });
    writeGeoTiffBufferMock.mockReturnValue(new Uint8Array([7, 8, 9]).buffer);

    await exportFenceGeoTiff({
      file,
      gridCellSize: 20,
      fence: {
        ...fence,
        summary: {
          ...fence.summary,
          bbox: [100, 180, 120, 200],
        },
        geometry: {
          ...fence.geometry,
          coordinates: [
            [
              [100, 200],
              [120, 200],
              [120, 180],
              [100, 180],
              [100, 200],
            ],
          ],
        },
      },
    });

    const aggregatedCall = vi.mocked(writeGeoTiffBufferMock).mock.calls[0]?.[0];
    expect(aggregatedCall?.bands[0]).toEqual(new Float32Array([4, 4, 4, 4]));
  });

  it('promotes integer source rasters to Float32 so fractional grid means are not truncated', async () => {
    const file = new File(['demo'], 'uint16.tif', { type: 'image/tiff' });
    const image = {
      getWidth: () => 2,
      getHeight: () => 2,
      getOrigin: () => [100, 200, 0] as [number, number, number],
      getResolution: () => [10, -10, 0] as [number, number, number],
      getBitsPerSample: () => 16,
      getSampleFormat: () => 1,
      getSamplesPerPixel: () => 1,
      getGDALNoData: () => null,
      getFileDirectory: () => ({
        PhotometricInterpretation: 1,
      }),
      readRasters: vi.fn().mockResolvedValue([new Uint16Array([1, 2, 3, 4])]),
    };

    readBlobBufferMock.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    fromArrayBufferMock.mockResolvedValue({
      getImage: vi.fn().mockResolvedValue(image),
    });
    writeGeoTiffBufferMock.mockReturnValue(new Uint8Array([7, 8, 9]).buffer);

    await exportFenceGeoTiff({
      file,
      gridCellSize: 20,
      fence: {
        ...fence,
        summary: {
          ...fence.summary,
          bbox: [100, 180, 120, 200],
        },
        geometry: {
          ...fence.geometry,
          coordinates: [
            [
              [100, 200],
              [120, 200],
              [120, 180],
              [100, 180],
              [100, 200],
            ],
          ],
        },
      },
    });

    const call = vi.mocked(writeGeoTiffBufferMock).mock.calls[0]?.[0];
    // 均值 2.5 无法用 Uint16 表示：必须提升为 Float32，而不是被截断为 2
    expect(call?.bands[0]).toBeInstanceOf(Float32Array);
    expect(Array.from(call?.bands[0] ?? [])).toEqual([2.5, 2.5, 2.5, 2.5]);
    expect(call?.bitsPerSample).toEqual([32]);
    expect(call?.sampleFormat).toEqual([3]);
  });

  it('avoids picking a NoData sentinel that collides with an aggregated grid value', async () => {
    const file = new File(['demo'], 'nodata-zero.tif', { type: 'image/tiff' });
    const image = {
      getWidth: () => 2,
      getHeight: () => 2,
      getOrigin: () => [100, 200, 0] as [number, number, number],
      getResolution: () => [10, -10, 0] as [number, number, number],
      getBitsPerSample: () => 16,
      getSampleFormat: () => 2,
      getSamplesPerPixel: () => 1,
      getGDALNoData: () => 0,
      getFileDirectory: () => ({
        PhotometricInterpretation: 1,
      }),
      readRasters: vi.fn().mockResolvedValue([new Int16Array([-1, 1, -1, 1])]),
    };

    readBlobBufferMock.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    fromArrayBufferMock.mockResolvedValue({
      getImage: vi.fn().mockResolvedValue(image),
    });
    writeGeoTiffBufferMock.mockReturnValue(new Uint8Array([7, 8, 9]).buffer);

    await exportFenceGeoTiff({
      file,
      gridCellSize: 20,
      fence: {
        ...fence,
        summary: {
          ...fence.summary,
          bbox: [100, 180, 120, 200],
        },
        geometry: {
          ...fence.geometry,
          coordinates: [
            [
              [100, 200],
              [120, 200],
              [120, 180],
              [100, 180],
              [100, 200],
            ],
          ],
        },
      },
    });

    const call = vi.mocked(writeGeoTiffBufferMock).mock.calls[0]?.[0];
    // 四个像元均值为 0，而源 NoData 恰好也是 0：
    // 若沿用源 NoData，整个栅格会被下游当成无值，因此必须改选哨兵。
    expect(Array.from(call?.bands[0] ?? [])).toEqual([0, 0, 0, 0]);
    expect(call?.gdalNoData).toBeDefined();
    expect(call?.gdalNoData).not.toBe('0');
    expect(Number(call?.gdalNoData)).toBe(-3.4028234663852886e38);
  });

  it('embeds the project snapshot into the exported file when one is provided', async () => {
    const file = new File(['demo'], 'test2.tif', { type: 'image/tiff' });

    readBlobBufferMock.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    fromArrayBufferMock.mockResolvedValue({
      getImage: vi.fn().mockResolvedValue(stubWideImage()),
    });
    writeGeoTiffBufferMock.mockReturnValue(new Uint8Array([7, 8, 9]).buffer);

    const snapshot = makeSnapshotFixture();
    const result = await exportFenceGeoTiff({
      file,
      fence,
      gridCellSize: 10,
      projectSnapshot: snapshot,
    });

    const call = vi.mocked(writeGeoTiffBufferMock).mock.calls[0]?.[0];
    expect(call?.imageDescription).toBe(encodeEmbeddedSnapshot(snapshot));
    expect(call?.imageDescription?.startsWith(EMBEDDED_SNAPSHOT_PREFIX)).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('skips embedding and warns when the snapshot exceeds the size budget', async () => {
    const file = new File(['demo'], 'big.tif', { type: 'image/tiff' });

    readBlobBufferMock.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    fromArrayBufferMock.mockResolvedValue({
      getImage: vi.fn().mockResolvedValue(stubWideImage()),
    });
    writeGeoTiffBufferMock.mockReturnValue(new Uint8Array([7, 8, 9]).buffer);

    // 用大量冗余顶点把配方撑过 32KB 上限
    const filler = Array.from({ length: 4000 }, () => [125, 165] as [number, number]);
    const snapshot = makeSnapshotFixture({
      fenceRings: [
        [
          [110, 180],
          [140, 180],
          [140, 150],
          [110, 150],
          ...filler,
          [110, 180],
        ],
      ],
    });

    const result = await exportFenceGeoTiff({
      file,
      fence,
      gridCellSize: 10,
      projectSnapshot: snapshot,
    });

    const call = vi.mocked(writeGeoTiffBufferMock).mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call?.imageDescription).toBeUndefined();
    expect(result.warnings[0]).toContain('已跳过内嵌');
  });

  it('preserves source geo tags while clipping a geographic raster by metric grid size', async () => {
    const geographicFence: FenceFeature = {
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [119.420001, 36.510001],
            [119.420901, 36.510001],
            [119.420901, 36.510601],
            [119.420001, 36.510601],
            [119.420001, 36.510001],
          ],
        ],
      },
      summary: {
        area: 0,
        bbox: [119.420001, 36.510001, 119.420901, 36.510601],
        vertexCount: 4,
      },
    };
    const metricTransform = createMetricTransform({
      crsCode: 'EPSG:4326',
      boundingBox: geographicFence.summary.bbox,
    });
    const file = new File(['demo'], 'gps.tif', { type: 'image/tiff' });
    const image = {
      getWidth: () => 2,
      getHeight: () => 2,
      getOrigin: () => [119.420001, 36.510601, 0] as [number, number, number],
      getResolution: () => [0.00045, -0.0003, 0] as [number, number, number],
      getBitsPerSample: () => 32,
      getSampleFormat: () => 3,
      getSamplesPerPixel: () => 1,
      getGDALNoData: () => null,
      getFileDirectory: () => ({
        PhotometricInterpretation: 1,
        ModelPixelScale: [0.00045, 0.0003, 0],
        GeoKeyDirectory: new Uint16Array([1, 1, 0, 1, 2048, 0, 1, 4326]),
        GeoAsciiParams: 'WGS 84|',
      }),
      readRasters: vi.fn().mockResolvedValue([new Float32Array([1, 3, 5, 7])]),
    };

    readBlobBufferMock.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    fromArrayBufferMock.mockResolvedValue({
      getImage: vi.fn().mockResolvedValue(image),
    });
    writeGeoTiffBufferMock.mockReturnValue(new Uint8Array([7, 8, 9]).buffer);

    await exportFenceGeoTiff({
      file,
      fence: geographicFence,
      gridCellSize: 10,
      metricTransform,
    });

    expect(writeGeoTiffBufferMock).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 2,
        height: 2,
        bands: [new Float32Array([1, 3, 5, 7])],
        geoKeyDirectory: new Uint16Array([1, 1, 0, 1, 2048, 0, 1, 4326]),
        geoAsciiParams: 'WGS 84|',
        modelTiepoint: [0, 0, 0, 119.420001, 36.510601, 0],
        modelPixelScale: [0.00045, 0.0003, 0],
      }),
    );
  });

  it('scales per-area prescription rates by the grid cell area', async () => {
    const file = new File(['demo'], 'per-area.tif', { type: 'image/tiff' });
    const image = {
      getWidth: () => 2,
      getHeight: () => 2,
      getOrigin: () => [100, 200, 0] as [number, number, number],
      getResolution: () => [10, -10, 0] as [number, number, number],
      getBitsPerSample: () => 32,
      getSampleFormat: () => 3,
      getSamplesPerPixel: () => 1,
      getGDALNoData: () => null,
      getFileDirectory: () => ({
        PhotometricInterpretation: 1,
      }),
      readRasters: vi.fn().mockResolvedValue([new Float32Array([0.1, 0.35, 0.55, 0.8])]),
    };

    readBlobBufferMock.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    fromArrayBufferMock.mockResolvedValue({
      getImage: vi.fn().mockResolvedValue(image),
    });
    writeGeoTiffBufferMock.mockReturnValue(new Uint8Array([7, 8, 9]).buffer);

    await exportFenceGeoTiff({
      file,
      // 单元格 10m × 10m = 100 m²
      gridCellSize: 10,
      fence: {
        ...fence,
        summary: {
          ...fence.summary,
          bbox: [100, 180, 120, 200],
        },
        geometry: {
          ...fence.geometry,
          coordinates: [
            [
              [100, 200],
              [120, 200],
              [120, 180],
              [100, 180],
              [100, 200],
            ],
          ],
        },
      },
      activeClassificationLayer: {
        id: 'rules',
        label: '单位面积施肥',
        mode: 'rules',
        noDataColor: '#00000000',
        gradientStops: [],
        rules: [
          {
            min: 0,
            max: null,
            color: '#226622',
            label: '统一速率',
            applicationRate: 0.5,
            applicationRateBasis: 'per-area',
            applicationRateUnit: 'per-square-meter',
          },
        ],
      },
    });

    const call = vi.mocked(writeGeoTiffBufferMock).mock.calls[0]?.[0];
    // 0.5 /m² × 100 m² = 50 每格（若误按单格用量处理则会写成 0.5）
    expect(Array.from(call?.bands[1] ?? [])).toEqual([50, 50, 50, 50]);
  });

  it('writes prescription values as a readable extra sample band', async () => {
    const file = new File(['demo'], 'prescription.tif', { type: 'image/tiff' });
    const image = {
      getWidth: () => 2,
      getHeight: () => 2,
      getOrigin: () => [100, 200, 0] as [number, number, number],
      getResolution: () => [10, -10, 0] as [number, number, number],
      getBitsPerSample: () => 32,
      getSampleFormat: () => 3,
      getSamplesPerPixel: () => 1,
      getGDALNoData: () => null,
      getFileDirectory: () => ({
        PhotometricInterpretation: 1,
        ModelPixelScale: [10, 10, 0],
        GeoKeyDirectory: new Uint16Array([1, 1, 0, 1, 3072, 0, 1, 4549]),
      }),
      readRasters: vi.fn().mockResolvedValue([new Float32Array([0.1, 0.35, 0.55, 0.8])]),
    };

    readBlobBufferMock.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    fromArrayBufferMock.mockResolvedValue({
      getImage: vi.fn().mockResolvedValue(image),
    });
    writeGeoTiffBufferMock.mockReturnValue(new Uint8Array([7, 8, 9]).buffer);

    const result = await exportFenceGeoTiff({
      file,
      gridCellSize: 10,
      fence: {
        ...fence,
        summary: {
          ...fence.summary,
          bbox: [100, 180, 120, 200],
        },
        geometry: {
          ...fence.geometry,
          coordinates: [
            [
              [100, 200],
              [120, 200],
              [120, 180],
              [100, 180],
              [100, 200],
            ],
          ],
        },
      },
      activeClassificationLayer: {
        id: 'rules',
        label: '变量施肥',
        mode: 'rules',
        noDataColor: '#00000000',
        gradientStops: [],
        rules: [
          { min: 0, max: 0.2, color: '#111111', label: 'low', applicationRate: 50 },
          { min: 0.2, max: 0.6, color: '#222222', label: 'mid', applicationRate: 80 },
          { min: 0.6, max: null, color: '#333333', label: 'high', applicationRate: 120 },
        ],
      },
    });

    expect(writeGeoTiffBufferMock).toHaveBeenCalledTimes(1);
    const firstCall = vi.mocked(writeGeoTiffBufferMock).mock.calls[0]?.[0];
    expect(firstCall?.samplesPerPixel).toBe(2);
    expect(firstCall?.bitsPerSample).toEqual([32, 32]);
    expect(firstCall?.sampleFormat).toEqual([3, 3]);
    expect(firstCall?.bands).toHaveLength(2);
    expect(Array.from(firstCall?.bands[0] ?? [])).toEqual(
      expect.arrayContaining([
        expect.closeTo(0.1, 6),
        expect.closeTo(0.35, 6),
        expect.closeTo(0.55, 6),
        expect.closeTo(0.8, 6),
      ]),
    );
    expect(Array.from(firstCall?.bands[1] ?? [])).toEqual([50, 80, 80, 120]);
    // 处方波段必须被声明为附加波段，否则重新导入时会被当成数据波段
    expect(firstCall?.extraSamplesCount).toBe(1);
    expect(result.blob).toBeInstanceOf(Blob);
  });

  it('keeps an RGB source readable as 3 data bands after appending the prescription band', async () => {
    const file = new File(['demo'], 'rgb.tif', { type: 'image/tiff' });
    const image = {
      getWidth: () => 2,
      getHeight: () => 2,
      getOrigin: () => [100, 200, 0] as [number, number, number],
      getResolution: () => [10, -10, 0] as [number, number, number],
      getBitsPerSample: () => 8,
      getSampleFormat: () => 1,
      getSamplesPerPixel: () => 3,
      getGDALNoData: () => null,
      getFileDirectory: () => ({
        // RGB 源：3 个数据波段，追加 1 个处方波段后 SamplesPerPixel=4
        PhotometricInterpretation: 2,
        ModelPixelScale: [10, 10, 0],
        GeoKeyDirectory: new Uint16Array([1, 1, 0, 1, 3072, 0, 1, 4549]),
      }),
      readRasters: vi
        .fn()
        .mockResolvedValue([
          new Float32Array([0.1, 0.35, 0.55, 0.8]),
          new Float32Array([1, 1, 1, 1]),
          new Float32Array([2, 2, 2, 2]),
        ]),
    };

    readBlobBufferMock.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    fromArrayBufferMock.mockResolvedValue({
      getImage: vi.fn().mockResolvedValue(image),
    });
    writeGeoTiffBufferMock.mockReturnValue(new Uint8Array([7, 8, 9]).buffer);

    await exportFenceGeoTiff({
      file,
      gridCellSize: 10,
      fence: {
        ...fence,
        summary: { ...fence.summary, bbox: [100, 180, 120, 200] },
        geometry: {
          ...fence.geometry,
          coordinates: [
            [
              [100, 200],
              [120, 200],
              [120, 180],
              [100, 180],
              [100, 200],
            ],
          ],
        },
      },
      activeClassificationLayer: {
        id: 'rules',
        label: '变量施肥',
        mode: 'rules',
        noDataColor: '#00000000',
        gradientStops: [],
        rules: [{ min: 0, max: null, color: '#111111', label: 'all', applicationRate: 50 }],
      },
    });

    const firstCall = vi.mocked(writeGeoTiffBufferMock).mock.calls[0]?.[0];

    expect(firstCall?.samplesPerPixel).toBe(4);
    expect(firstCall?.photometricInterpretation).toBe(2);
    expect(firstCall?.extraSamplesCount).toBe(1);
  });
});

describe('downloadExportedGeoTiff', () => {
  it('creates an object url and triggers anchor download', async () => {
    const click = vi.fn();
    const anchor = {
      click,
      href: '',
      download: '',
    } as unknown as HTMLAnchorElement;

    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(),
      writable: true,
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: vi.fn(),
      writable: true,
      configurable: true,
    });

    const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:demo');
    const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const createElementSpy = vi.spyOn(document, 'createElement').mockReturnValue(anchor);

    await downloadExportedGeoTiff(new Blob(['x']), 'demo.tif');

    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(createElementSpy).toHaveBeenCalledWith('a');
    expect(anchor.download).toBe('demo.tif');
    expect(anchor.href).toBe('blob:demo');
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:demo');
  });
});
