import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromArrayBuffer } from 'geotiff';

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
}));

vi.mock('@/shared/geo/geotiffWriter', () => ({
  writeGeoTiffBuffer: writeGeoTiffBufferMock,
}));

import { exportFenceGeoTiff, downloadExportedGeoTiff } from '@/features/export/exportGeoTiff';
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
    expect(firstCall?.bands[0]).toEqual(new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
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
        bands: [expect.any(Float64Array), expect.any(Float64Array)],
        gdalNoData: undefined,
      }),
    );
    const multiBandCall = vi.mocked(writeGeoTiffBufferMock).mock.calls[0]?.[0];
    expect(multiBandCall?.bands[0]).toEqual(new Float64Array([1, 2, 3, 4]));
    expect(multiBandCall?.bands[1]).toEqual(new Float64Array([1, 2, 3, 4]));
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
    expect(aggregatedCall?.bands[0]).toEqual(new Float64Array([4, 4, 4, 4]));
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
        bands: [new Float64Array([1, 3, 5, 7])],
        geoKeyDirectory: new Uint16Array([1, 1, 0, 1, 2048, 0, 1, 4326]),
        geoAsciiParams: 'WGS 84|',
        modelTiepoint: [0, 0, 0, 119.420001, 36.510601, 0],
        modelPixelScale: [0.00045, 0.0003, 0],
      }),
    );
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
    expect(result.blob).toBeInstanceOf(Blob);
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
