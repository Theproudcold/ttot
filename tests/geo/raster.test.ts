import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fromArrayBufferMock, fromBlobMock } = vi.hoisted(() => ({
  fromArrayBufferMock: vi.fn(),
  fromBlobMock: vi.fn(),
}));

vi.mock('geotiff', () => ({
  fromArrayBuffer: fromArrayBufferMock,
  fromBlob: fromBlobMock,
}));

import {
  buildClassificationBreaks,
  buildClassifiedPreviewRgba,
  buildPreviewRgba,
  buildRasterMetadata,
  calculatePreviewDimensions,
  calculateProgressPercent,
  findClassificationBreakForValue,
  getCrsCodeFromGeoKeys,
  getSampleRanges,
  loadRasterMetadata,
} from '@/shared/geo/raster';

beforeEach(() => {
  fromArrayBufferMock.mockReset();
  fromBlobMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getCrsCodeFromGeoKeys', () => {
  it('prefers projected EPSG code when present', () => {
    expect(
      getCrsCodeFromGeoKeys({
        ProjectedCSTypeGeoKey: 4549,
        GeographicTypeGeoKey: 4490,
      }),
    ).toBe('EPSG:4549');
  });

  it('falls back to geographic EPSG code when projected code is missing', () => {
    expect(
      getCrsCodeFromGeoKeys({
        GeographicTypeGeoKey: 4490,
      }),
    ).toBe('EPSG:4490');
  });
});

describe('buildRasterMetadata', () => {
  it('normalizes raw geotiff metadata into app metadata', () => {
    const metadata = buildRasterMetadata({
      sourceUrl: '/assets/test2.tif',
      fileName: 'test2.tif',
      width: 5647,
      height: 3179,
      boundingBox: [447934.5768945037, 4041573.0550815426, 448017.5877945037, 4041619.7863815427],
      origin: [447934.5768945037, 4041619.7863815427, 0],
      resolution: [0.0147, -0.0147, 0],
      geoKeys: {
        GTCitationGeoKey: 'CGCS2000 / 3-degree Gauss-Kruger CM 120E',
        ProjectedCSTypeGeoKey: 4549,
      },
      samplesPerPixel: 1,
    });

    expect(metadata).toMatchObject({
      sourceUrl: '/assets/test2.tif',
      width: 5647,
      height: 3179,
      crsCode: 'EPSG:4549',
      crsName: 'CGCS2000 / 3-degree Gauss-Kruger CM 120E',
      isProjected: true,
      samplesPerPixel: 1,
      cellSize: {
        x: 0.0147,
        y: 0.0147,
        unit: 'm',
      },
    });
  });
});

describe('loadRasterMetadata', () => {
  it('reads local GeoTIFF metadata from array-buffer source after local file buffering', async () => {
    const originalFileReader = globalThis.FileReader;
    // @ts-expect-error test override
    globalThis.FileReader = undefined;

    const imageMock = {
      getWidth: () => 5647,
      getHeight: () => 3179,
      getBoundingBox: () =>
        [447934.5768945037, 4041573.0550815426, 448017.5877945037, 4041619.7863815427] as [
          number,
          number,
          number,
          number,
        ],
      getOrigin: () => [447934.5768945037, 4041619.7863815427, 0] as [number, number, number],
      getResolution: () => [0.0147, -0.0147, 0] as [number, number, number],
      getGeoKeys: () => ({
        GTCitationGeoKey: 'CGCS2000 / 3-degree Gauss-Kruger CM 120E',
        ProjectedCSTypeGeoKey: 4549,
      }),
      getSamplesPerPixel: () => 1,
    };
    fromArrayBufferMock.mockResolvedValue({
      getImage: vi.fn().mockResolvedValue(imageMock),
    });

    const file = Object.assign(new Blob(['fake'], { type: 'image/tiff' }), {
      name: 'test2.tif',
      arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
    }) as unknown as File;
    const progress = vi.fn();
    const metadata = await loadRasterMetadata(file, progress);

    expect(fromBlobMock).not.toHaveBeenCalled();
    expect(fromArrayBufferMock).toHaveBeenCalledTimes(1);
    expect(metadata.fileName).toBe('test2.tif');
    expect(progress).toHaveBeenCalledWith(0, '正在读取本地文件');
    expect(progress).toHaveBeenCalledWith(100, '正在读取本地文件');
    expect(progress).toHaveBeenCalledWith(96, '正在解析元信息');
    expect(progress).toHaveBeenCalledWith(100, '正在整理地图参数');

    globalThis.FileReader = originalFileReader;
  });

  it('reports staged local progress even when FileReader emits no intermediate progress events', async () => {
    const originalFileReader = globalThis.FileReader;

    class MockFileReader {
      public result: ArrayBuffer | string | null = new Uint8Array([1, 2, 3]).buffer;

      public error: DOMException | null = null;

      public onloadstart: ((event: ProgressEvent<FileReader>) => void) | null = null;

      public onprogress: ((event: ProgressEvent<FileReader>) => void) | null = null;

      public onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;

      public onload: ((event: ProgressEvent<FileReader>) => void) | null = null;

      readAsArrayBuffer(_blob: Blob) {
        this.onloadstart?.(new ProgressEvent('loadstart') as ProgressEvent<FileReader>);
        this.onload?.(new ProgressEvent('load') as ProgressEvent<FileReader>);
      }
    }

    // @ts-expect-error test override
    globalThis.FileReader = MockFileReader;

    const imageMock = {
      getWidth: () => 5647,
      getHeight: () => 3179,
      getBoundingBox: () =>
        [447934.5768945037, 4041573.0550815426, 448017.5877945037, 4041619.7863815427] as [
          number,
          number,
          number,
          number,
        ],
      getOrigin: () => [447934.5768945037, 4041619.7863815427, 0] as [number, number, number],
      getResolution: () => [0.0147, -0.0147, 0] as [number, number, number],
      getGeoKeys: () => ({
        GTCitationGeoKey: 'CGCS2000 / 3-degree Gauss-Kruger CM 120E',
        ProjectedCSTypeGeoKey: 4549,
      }),
      getSamplesPerPixel: () => 1,
    };
    fromArrayBufferMock.mockResolvedValue({
      getImage: vi.fn().mockResolvedValue(imageMock),
    });

    const file = new File(['fake'], 'test2.tif', { type: 'image/tiff' });
    const progress = vi.fn();

    await loadRasterMetadata(file, progress);

    expect(progress).toHaveBeenCalledWith(0, '正在读取本地文件');
    expect(progress).toHaveBeenCalledWith(5, '正在读取本地文件');
    expect(progress).toHaveBeenCalledWith(96, '正在解析元信息');

    globalThis.FileReader = originalFileReader;
  });

  it('yields a browser frame after switching to metadata parsing phase', async () => {
    const originalFileReader = globalThis.FileReader;
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    let rafCallback: FrameRequestCallback | null = null;

    // @ts-expect-error test override
    globalThis.FileReader = undefined;
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      rafCallback = callback;
      return 1;
    });
    globalThis.cancelAnimationFrame = vi.fn();

    const imageMock = {
      getWidth: () => 5647,
      getHeight: () => 3179,
      getBoundingBox: () =>
        [447934.5768945037, 4041573.0550815426, 448017.5877945037, 4041619.7863815427] as [
          number,
          number,
          number,
          number,
        ],
      getOrigin: () => [447934.5768945037, 4041619.7863815427, 0] as [number, number, number],
      getResolution: () => [0.0147, -0.0147, 0] as [number, number, number],
      getGeoKeys: () => ({
        GTCitationGeoKey: 'CGCS2000 / 3-degree Gauss-Kruger CM 120E',
        ProjectedCSTypeGeoKey: 4549,
      }),
      getSamplesPerPixel: () => 1,
    };
    fromArrayBufferMock.mockResolvedValue({
      getImage: vi.fn().mockResolvedValue(imageMock),
    });

    const file = Object.assign(new Blob(['fake'], { type: 'image/tiff' }), {
      name: 'test2.tif',
      arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
    }) as unknown as File;
    const progress = vi.fn();

    const pendingMetadata = loadRasterMetadata(file, progress);
    await Promise.resolve();
    await Promise.resolve();

    expect(progress).toHaveBeenCalledWith(96, '正在解析元信息');
    expect(fromArrayBufferMock).not.toHaveBeenCalled();

    if (!rafCallback) {
      throw new Error('requestAnimationFrame callback was not scheduled');
    }

    const scheduledFrame = rafCallback as FrameRequestCallback;
    scheduledFrame(16);
    const metadata = await pendingMetadata;

    expect(fromArrayBufferMock).toHaveBeenCalledTimes(1);
    expect(metadata.fileName).toBe('test2.tif');

    globalThis.FileReader = originalFileReader;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  });
});

describe('calculateProgressPercent', () => {
  it('returns rounded percentage when total bytes are known', () => {
    expect(calculateProgressPercent(512, 1024)).toBe(50);
  });

  it('never stays at zero after bytes have started arriving', () => {
    expect(calculateProgressPercent(1, 1024)).toBe(1);
  });

  it('returns null when total bytes are missing', () => {
    expect(calculateProgressPercent(512, null)).toBeNull();
  });

  it('falls back to stepped progress when total bytes are unknown but data is flowing', () => {
    expect(calculateProgressPercent(1024, null, 0)).toBe(5);
    expect(calculateProgressPercent(2048, null, 5)).toBe(10);
    expect(calculateProgressPercent(4096, null, 82)).toBe(85);
  });
});

describe('calculatePreviewDimensions', () => {
  it('downscales large rasters to a bounded preview size', () => {
    expect(calculatePreviewDimensions(5647, 3179)).toEqual({
      width: 2048,
      height: 1152,
    });
  });

  it('keeps small rasters at their original size', () => {
    expect(calculatePreviewDimensions(800, 600)).toEqual({
      width: 800,
      height: 600,
    });
  });
});

describe('buildPreviewRgba', () => {
  it('normalizes grayscale samples and masks nodata pixels', () => {
    expect(buildPreviewRgba([0, 10, 20, 30], 2, 2, 1, 0)).toEqual(
      new Uint8ClampedArray([
        0, 0, 0, 0,
        0, 0, 0, 255,
        128, 128, 128, 255,
        255, 255, 255, 255,
      ]),
    );
  });
});

describe('getSampleRanges', () => {
  it('collects valid ranges for each band while ignoring nodata', () => {
    expect(getSampleRanges([0, 0.1, 0, 0.5, 0, -0.2], 1, 0)).toEqual([
      {
        min: -0.2,
        max: 0.5,
      },
    ]);
  });
});

describe('buildClassificationBreaks', () => {
  it('aligns automatic single-band ranges to the configured step', () => {
    const breaks = buildClassificationBreaks(
      {
        min: -0.3512,
        max: 0.9192,
      },
      {
        min: null,
        max: null,
        step: 0.2,
      },
    );

    expect(breaks).toHaveLength(7);
    expect(breaks[0]).toMatchObject({
      min: -0.4,
      max: -0.2,
      label: '-0.40 ~ -0.20',
    });
    expect(breaks.at(-1)).toMatchObject({
      min: 0.8,
      max: 1,
      label: '0.80 ~ 1.00',
    });
  });
});

describe('findClassificationBreakForValue', () => {
  it('returns the matching break and clamps values outside the configured range', () => {
    const breaks = buildClassificationBreaks(
      { min: 0, max: 0.4 },
      { min: 0, max: 0.4, step: 0.2 },
      ['#eeeeee', '#111111'],
    );

    expect(findClassificationBreakForValue(0.15, breaks)?.label).toBe('0.00 ~ 0.20');
    expect(findClassificationBreakForValue(0.35, breaks)?.label).toBe('0.20 ~ 0.40');
    expect(findClassificationBreakForValue(-1, breaks)?.label).toBe('0.00 ~ 0.20');
    expect(findClassificationBreakForValue(10, breaks)?.label).toBe('0.20 ~ 0.40');
  });
});

describe('buildClassifiedPreviewRgba', () => {
  it('maps classified grayscale colors and keeps nodata pixels transparent', () => {
    const breaks = buildClassificationBreaks(
      { min: 0, max: 0.4 },
      { min: 0, max: 0.4, step: 0.2 },
      ['#eeeeee', '#111111'],
    );

    expect(buildClassifiedPreviewRgba([0, 0.1, 0.25, 0.35], 2, 2, breaks, 0)).toEqual(
      new Uint8ClampedArray([
        0, 0, 0, 0,
        238, 238, 238, 255,
        17, 17, 17, 255,
        17, 17, 17, 255,
      ]),
    );
  });
});
