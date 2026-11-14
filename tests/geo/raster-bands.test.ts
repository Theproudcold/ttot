import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fromArrayBufferMock } = vi.hoisted(() => ({
  fromArrayBufferMock: vi.fn(),
}));

vi.mock('geotiff', () => ({
  fromArrayBuffer: fromArrayBufferMock,
}));

import {
  buildBandSampleCacheKey,
  computeBandMeans,
  loadRasterBandSamples,
} from '@/shared/geo/rasterBands';
import { resetRasterSessionCache } from '@/shared/geo/rasterIo';

function makeImage(overrides: Record<string, unknown> = {}) {
  return {
    getWidth: () => 2,
    getHeight: () => 2,
    getSamplesPerPixel: () => 3,
    getGDALNoData: () => -9999,
    getFileDirectory: () => ({ ExtraSamples: [0] }),
    getGDALMetadata: (sample: number) => ({
      BANDNAME: ['Blue', 'Green', 'Red'][sample],
      WAVELENGTH: [475, 560, 660][sample],
    }),
    readRasters: vi.fn().mockResolvedValue([
      Float32Array.from([1, 2, 3, 4]),
      Float32Array.from([5, 6, 7, 8]),
      Float32Array.from([9, 10, 11, 12]),
    ]),
    ...overrides,
  };
}

const file = new File([new Uint8Array([1, 2, 3])], 'multi.tif', { type: 'image/tiff' });

beforeEach(() => {
  fromArrayBufferMock.mockReset();
  resetRasterSessionCache();
});

describe('loadRasterBandSamples', () => {
  it('reads every band at preview resolution together with its metadata', async () => {
    const image = makeImage();
    fromArrayBufferMock.mockResolvedValue({ getImage: vi.fn().mockResolvedValue(image) });

    const result = await loadRasterBandSamples(file);

    expect(result.width).toBe(2);
    expect(result.height).toBe(2);
    expect(result.sampleCount).toBe(3);
    // ExtraSamples 声明了 1 个附加波段 → 数据波段只有 2 个
    expect(result.dataBandCount).toBe(2);
    expect(result.noDataValue).toBe(-9999);
    expect(Array.from(result.bands[1])).toEqual([5, 6, 7, 8]);
    expect(result.metadataByBand[0].BANDNAME).toBe('Blue');
    expect(image.readRasters).toHaveBeenCalledWith(
      expect.objectContaining({ interleave: false, samples: [0, 1, 2], fillValue: -9999 }),
    );
  });

  it('caps the number of bands it reads', async () => {
    const image = makeImage();
    fromArrayBufferMock.mockResolvedValue({ getImage: vi.fn().mockResolvedValue(image) });

    const result = await loadRasterBandSamples(file, { maxSamples: 2 });

    expect(result.sampleCount).toBe(2);
    expect(image.readRasters).toHaveBeenCalledWith(
      expect.objectContaining({ samples: [0, 1] }),
    );
  });

  it('survives images without GDAL metadata or a nodata tag', async () => {
    const image = makeImage({
      getGDALNoData: () => null,
      getFileDirectory: () => ({}),
      getGDALMetadata: () => {
        throw new Error('no metadata');
      },
    });
    fromArrayBufferMock.mockResolvedValue({ getImage: vi.fn().mockResolvedValue(image) });

    const result = await loadRasterBandSamples(file);

    expect(result.noDataValue).toBeNull();
    expect(result.dataBandCount).toBe(3);
    expect(result.metadataByBand).toEqual([{}, {}, {}]);
  });
});

describe('computeBandMeans', () => {
  it('averages finite values per band and reports null for empty bands', () => {
    expect(
      computeBandMeans([
        [1, 2, 3],
        [Number.NaN, Number.NaN],
        new Float32Array([0.5, 0.25]),
      ]),
    ).toEqual([2, null, 0.375]);
  });
});

describe('buildBandSampleCacheKey', () => {
  it('matches the key used by the raster loader so the session is shared', async () => {
    // 必须与 useRasterLoader 传给 Worker 的 sourceKey 一致，否则会重复解析
    const { buildRasterSourceKey } = await import('@/shared/geo/rasterIo');
    expect(buildBandSampleCacheKey(file)).toBe(buildRasterSourceKey(file));
  });
});
