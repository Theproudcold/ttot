import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fromArrayBufferMock, writeArrayBufferMock, readBlobBufferMock } = vi.hoisted(() => ({
  fromArrayBufferMock: vi.fn(),
  writeArrayBufferMock: vi.fn(),
  readBlobBufferMock: vi.fn(),
}));

vi.mock('geotiff', () => ({
  fromArrayBuffer: fromArrayBufferMock,
  writeArrayBuffer: writeArrayBufferMock,
}));

vi.mock('@/shared/geo/raster', () => ({
  readBlobBuffer: readBlobBufferMock,
}));

import { exportFenceGeoTiff, downloadExportedGeoTiff } from '@/features/export/exportGeoTiff';
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
  writeArrayBufferMock.mockReset();
  readBlobBufferMock.mockReset();
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
      }),
      readRasters: vi.fn().mockResolvedValue([new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9])]),
    };

    readBlobBufferMock.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    fromArrayBufferMock.mockResolvedValue({
      getImage: vi.fn().mockResolvedValue(image),
    });
    writeArrayBufferMock.mockReturnValue(new Uint8Array([7, 8, 9]).buffer);

    const result = await exportFenceGeoTiff({
      file,
      fence,
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
    expect(writeArrayBufferMock).toHaveBeenCalledTimes(1);
    expect(writeArrayBufferMock).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        ImageWidth: 3,
        ImageLength: 3,
        GDAL_NODATA: '-3.4028234663852886e+38',
        ProjectedCSTypeGeoKey: 4549,
      }),
    );
    expect(result.filename).toBe('test2-clipped.tif');
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.blob.type).toBe('image/tiff');
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
