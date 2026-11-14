import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RasterClassificationLayer } from '@/shared/types/raster';

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
  buildDefaultNdviClassificationLayer,
  buildRasterClassificationLegendData,
  buildRasterClassificationPreviewRgba,
  buildPreviewRgba,
  buildRasterMetadata,
  calculatePreviewDimensions,
  calculateProgressPercent,
  findRasterClassificationMatch,
  findClassificationBreakForValue,
  getCrsCodeFromGeoKeys,
  getSampleRanges,
  loadRasterMetadata,
  loadRasterPreview,
  loadRasterValidityMask,
  resetRasterSessionCache,
} from '@/shared/geo/raster';
import { readGeoTiffFenceWindow } from '@/shared/geo/geotiffExport';

beforeEach(() => {
  fromArrayBufferMock.mockReset();
  fromBlobMock.mockReset();
  resetRasterSessionCache();
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
  it('builds projected raster metadata with metric extent equal to the source extent', () => {
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
      coordinateDisplayMode: 'projected',
      cellSize: {
        x: 0.0147,
        y: 0.0147,
        unit: 'm',
      },
      metricExtent: {
        minX: 447934.5768945037,
        minY: 4041573.0550815426,
        maxX: 448017.5877945037,
        maxY: 4041619.7863815427,
      },
    });

    expect(metadata.metricWidth).toBeCloseTo(83.0109, 4);
    expect(metadata.metricHeight).toBeCloseTo(46.7313, 4);
    expect(metadata.boundingBox).toEqual([
      447934.5768945037,
      4041573.0550815426,
      448017.5877945037,
      4041619.7863815427,
    ]);
    expect(metadata.metricTransform.toMetric([10, 20])).toEqual([10, 20]);
    expect(metadata.metricTransform.fromMetric([30, 40])).toEqual([30, 40]);
  });

  it('builds geographic raster metadata with degree cell size and meter-based metric dimensions', () => {
    const metadata = buildRasterMetadata({
      fileName: 'gps-ndvi.tif',
      width: 2250,
      height: 1500,
      boundingBox: [119.420001, 36.510001, 119.420901, 36.510601],
      origin: [119.420001, 36.510601, 0],
      resolution: [0.0000004, -0.0000004, 0],
      geoKeys: {
        GeographicTypeGeoKey: 4326,
      },
      samplesPerPixel: 1,
    });

    expect(metadata.crsCode).toBe('EPSG:4326');
    expect(metadata.isProjected).toBe(false);
    expect(metadata.coordinateDisplayMode).toBe('geographic');
    expect(metadata.cellSize).toEqual({
      x: 0.0000004,
      y: 0.0000004,
      unit: 'degree',
    });
    expect(metadata.metricExtent.minX).toBeCloseTo(-40.262864, 3);
    expect(metadata.metricExtent.minY).toBeCloseTo(-33.395847, 3);
    expect(metadata.metricExtent.maxX).toBeCloseTo(40.262864, 3);
    expect(metadata.metricExtent.maxY).toBeCloseTo(33.395847, 3);
    expect(metadata.metricWidth).toBeCloseTo(80.525727, 3);
    expect(metadata.metricHeight).toBeCloseTo(66.791694, 3);
    expect(metadata.boundingBox).toEqual([119.420001, 36.510001, 119.420901, 36.510601]);

    const metricPoint = metadata.metricTransform.toMetric([119.420451, 36.510301]);
    expect(metricPoint[0]).toBeCloseTo(0, 6);
    expect(metricPoint[1]).toBeCloseTo(0, 6);
  });

  it('keeps unknown CRS metadata on an explicit unknown-unit fallback', () => {
    const metadata = buildRasterMetadata({
      fileName: 'unknown.tif',
      width: 10,
      height: 10,
      boundingBox: [10, 20, 11, 21],
      origin: [10, 21, 0],
      resolution: [0.5, -0.5, 0],
      geoKeys: {},
      samplesPerPixel: 1,
    });

    expect(metadata.crsCode).toBe('UNKNOWN');
    expect(metadata.crsName).toBe('UNKNOWN');
    expect(metadata.isProjected).toBe(false);
    expect(metadata.cellSize.unit).toBe('unknown');
    expect(metadata.coordinateDisplayMode).toBe('unknown');
    expect(metadata.boundingBox).toEqual([10, 20, 11, 21]);
    expect(metadata.metricExtent).toEqual({
      minX: 10,
      minY: 20,
      maxX: 11,
      maxY: 21,
    });
    expect(metadata.metricTransform.toMetric([10.25, 20.75])).toEqual([10.25, 20.75]);
  });

  it('surfaces geographic metric transform errors during metadata construction', () => {
    expect(() =>
      buildRasterMetadata({
        fileName: 'too-large-gps.tif',
        width: 10,
        height: 10,
        boundingBox: [100, 30, 102, 31],
        origin: [100, 31, 0],
        resolution: [0.0002, -0.0002, 0],
        geoKeys: {
          GeographicTypeGeoKey: 4326,
        },
        samplesPerPixel: 1,
      }),
    ).toThrow('geographic bounding box exceeds local metric transform limit');
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

    try {
      const pendingMetadata = loadRasterMetadata(file, progress);
      await Promise.resolve();
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
    } finally {
      globalThis.FileReader = originalFileReader;
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    }
  });
});

describe('loadRasterPreview', () => {
  it('keeps two-band sample data for import while rendering preview from the primary band', async () => {
    const originalCreateElement = document.createElement.bind(document);
    const putImageData = vi.fn();
    const createImageData = vi.fn((width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
      width,
      height,
    }));
    const toDataURL = vi.fn(() => 'data:image/png;base64,preview');
    const getContext = vi.fn(() => ({
      createImageData,
      putImageData,
    }));
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext,
          toDataURL,
        } as unknown as HTMLCanvasElement;
      }

      return originalCreateElement(tagName);
    }) as typeof document.createElement);

    const readRasters = vi.fn().mockResolvedValue(new Float32Array([
      0.1, 50,
      0.35, 80,
      0.55, 80,
      0.8, 120,
    ]));
    fromArrayBufferMock.mockResolvedValue({
      getImage: vi.fn().mockResolvedValue({
        getWidth: () => 2,
        getHeight: () => 2,
        getSamplesPerPixel: () => 2,
        getGDALNoData: () => null,
        readRasters,
      }),
    });

    const file = Object.assign(new Blob(['fake'], { type: 'image/tiff' }), {
      name: 'prescription.tif',
      arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
    }) as unknown as File;

    const preview = await loadRasterPreview(file);

    expect(readRasters).toHaveBeenCalledWith({
      width: 2,
      height: 2,
      interleave: true,
      samples: [0, 1],
      fillValue: Number.NaN,
    });
    expect(preview.url).toBe('data:image/png;base64,preview');
    expect(preview.sampleBandCount).toBe(2);
    // 未声明 ExtraSamples：两个波段都视为数据波段
    expect(preview.classificationBandCount).toBe(2);
    expect(Array.from(preview.sampleData ?? [])).toEqual(
      expect.arrayContaining([
        expect.closeTo(0.1, 6),
        50,
        expect.closeTo(0.35, 6),
        80,
        expect.closeTo(0.55, 6),
        80,
        expect.closeTo(0.8, 6),
        120,
      ]),
    );
    expect(preview.sampleRanges?.[0]?.min).toBeCloseTo(0.1, 6);
    expect(preview.sampleRanges?.[0]?.max).toBeCloseTo(0.8, 6);
    expect(preview.sampleRanges?.[1]).toEqual({
      min: 50,
      max: 120,
    });
    expect(putImageData).toHaveBeenCalledTimes(1);
    expect(putImageData.mock.calls[0]?.[0].data).toEqual(
      new Uint8ClampedArray([
        0, 0, 0, 255,
        91, 91, 91, 255,
        164, 164, 164, 255,
        255, 255, 255, 255,
      ]),
    );
  });

  it('excludes a trailing prescription band (ExtraSamples) from the classification band count', async () => {
    const readRasters = vi.fn().mockResolvedValue(
      Float32Array.from([
        0.1, 50,
        0.35, 80,
        0.55, 80,
        0.8, 120,
      ]),
    );
    fromArrayBufferMock.mockResolvedValue({
      getImage: vi.fn().mockResolvedValue({
        getWidth: () => 2,
        getHeight: () => 2,
        getSamplesPerPixel: () => 2,
        getGDALNoData: () => null,
        // 本工具 rules 模式导出时会写 ExtraSamples 声明追加的处方波段
        getFileDirectory: () => ({ ExtraSamples: [0] }),
        readRasters,
      }),
    });

    const file = Object.assign(new Blob(['fake'], { type: 'image/tiff' }), {
      name: 'exported-prescription.tif',
      arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
    }) as unknown as File;

    const preview = await loadRasterPreview(file);

    expect(preview.sampleBandCount).toBe(2);
    // 关键：数据波段只有 1 个，重新导入导出文件时分类着色才不会被门限挡掉
    expect(preview.classificationBandCount).toBe(1);
  });

  it('reuses the same decoded GeoTIFF session across metadata, preview, validity and fence-window reads', async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'shared-session.tif', {
      type: 'image/tiff',
    });
    const readRasters = vi.fn().mockImplementation((options?: { interleave?: boolean }) => {
      if (options?.interleave) {
        return Float32Array.from([1, 2, 3, 4]);
      }

      return [Float32Array.from([1, 2, 3, 4])];
    });
    const image = {
      getWidth: () => 2,
      getHeight: () => 2,
      getBoundingBox: () => [100, 180, 120, 200] as [number, number, number, number],
      getOrigin: () => [100, 200, 0] as [number, number, number],
      getResolution: () => [10, -10, 0] as [number, number, number],
      getGeoKeys: () => ({
        ProjectedCSTypeGeoKey: 4549,
      }),
      getSamplesPerPixel: () => 1,
      getBitsPerSample: () => 32,
      getSampleFormat: () => 3,
      getGDALNoData: () => -9999,
      getFileDirectory: () => ({
        PhotometricInterpretation: 1,
      }),
      fileDirectory: {
        GDAL_NODATA: -9999,
      },
      readRasters,
    };

    fromArrayBufferMock.mockResolvedValue({
      getImage: vi.fn().mockResolvedValue(image),
    });

    await loadRasterMetadata(file);
    await loadRasterPreview(file);
    await loadRasterValidityMask(file);
    await readGeoTiffFenceWindow({
      file,
      fenceRings: [
        [
          [100, 180],
          [120, 180],
          [120, 200],
          [100, 200],
          [100, 180],
        ],
      ],
      samples: [0],
    });

    expect(fromArrayBufferMock).toHaveBeenCalledTimes(1);
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

describe('buildDefaultNdviClassificationLayer', () => {
  it('builds a default NDVI gradient layer with expected stops', () => {
    expect(buildDefaultNdviClassificationLayer()).toEqual({
      id: 'ndvi-default',
      label: 'NDVI 默认分级',
      mode: 'gradient',
      noDataColor: '#00000000',
      gradientStops: [
        { value: -1, color: '#8b1e3f', label: '低植被' },
        { value: 0, color: '#d7c98b', label: '裸地' },
        { value: 0.4, color: '#7fbf3f', label: '中等植被' },
        { value: 0.7, color: '#1f7a1f', label: '高植被' },
        { value: 1, color: '#0b3d0b', label: '极高植被' },
      ],
      rules: [],
    });
  });
});

describe('findRasterClassificationMatch', () => {
  it('interpolates colors for gradient mode and clamps values beyond the stop range', () => {
    const layer = buildDefaultNdviClassificationLayer();

    expect(findRasterClassificationMatch(-2, layer)).toMatchObject({
      color: '#8b1e3f',
      label: '低植被',
      matchedRule: null,
    });
    expect(findRasterClassificationMatch(0.2, layer)).toMatchObject({
      color: '#abc465',
      label: '裸地 ~ 中等植被',
      matchedRule: null,
    });
    expect(findRasterClassificationMatch(2, layer)).toMatchObject({
      color: '#0b3d0b',
      label: '极高植被',
      matchedRule: null,
    });
  });

  it('returns the exact stop label when value lands exactly on an intermediate gradient stop', () => {
    const layer = buildDefaultNdviClassificationLayer();

    expect(findRasterClassificationMatch(0.4, layer)).toMatchObject({
      color: '#7fbf3f',
      label: '中等植被',
      matchedRule: null,
    });
    expect(findRasterClassificationMatch(0.7, layer)).toMatchObject({
      color: '#1f7a1f',
      label: '高植被',
      matchedRule: null,
    });
  });

  it('matches discrete rules including open-ended max=null intervals', () => {
    const layer = {
      id: 'ndvi-rules',
      label: 'NDVI 离散规则',
      mode: 'rules',
      noDataColor: '#00000000',
      gradientStops: [],
      rules: [
        { min: -1, max: 0, color: '#cccccc', label: '< 0' },
        { min: 0, max: 0.7, color: '#88cc44', label: '0.0 - 0.7' },
        { min: 0.7, max: null, color: '#226622', label: '0.7+' },
      ],
    } satisfies RasterClassificationLayer;

    expect(findRasterClassificationMatch(0.69, layer)).toMatchObject({
      color: '#88cc44',
      label: '0.0 - 0.7',
      matchedRule: {
        min: 0,
        max: 0.7,
        color: '#88cc44',
        label: '0.0 - 0.7',
      },
    });
    // 统一为闭区间后：恰好等于上界归入本级——与导出一致，也与标签"0.0 - 0.7"的字面一致
    expect(findRasterClassificationMatch(0.7, layer)).toMatchObject({
      color: '#88cc44',
      label: '0.0 - 0.7',
      matchedRule: {
        min: 0,
        max: 0.7,
        color: '#88cc44',
        label: '0.0 - 0.7',
      },
    });
    // 超过上界才进入下一级
    expect(findRasterClassificationMatch(0.701, layer)).toMatchObject({
      color: '#226622',
      label: '0.7+',
      matchedRule: {
        min: 0.7,
        max: null,
        color: '#226622',
        label: '0.7+',
      },
    });
    expect(findRasterClassificationMatch(1.2, layer)).toMatchObject({
      color: '#226622',
      label: '0.7+',
    });
  });
});

describe('buildRasterClassificationPreviewRgba', () => {
  it('renders preview rgba with gradient matches and transparent nodata pixels', () => {
    const layer = buildDefaultNdviClassificationLayer();

    expect(buildRasterClassificationPreviewRgba([0, 0.2, 0.7, 1], 2, 2, layer, 0)).toEqual(
      new Uint8ClampedArray([
        0, 0, 0, 0,
        171, 196, 101, 255,
        31, 122, 31, 255,
        11, 61, 11, 255,
      ]),
    );
  });
});

describe('buildRasterClassificationLegendData', () => {
  it('builds compact gradient legend data for the default NDVI layer', () => {
    const layer = buildDefaultNdviClassificationLayer();

    expect(buildRasterClassificationLegendData(layer)).toMatchObject({
      mode: 'gradient',
      gradientCss: expect.stringContaining('linear-gradient'),
      items: [
        { color: '#8b1e3f', label: '低植被' },
        { color: '#d7c98b', label: '裸地' },
        { color: '#7fbf3f', label: '中等植被' },
        { color: '#1f7a1f', label: '高植被' },
        { color: '#0b3d0b', label: '极高植被' },
      ],
    });
  });

  it('builds discrete legend items for rules layers without a gradient css string', () => {
    const layer = {
      id: 'landcover-rules',
      label: '土地覆盖',
      mode: 'rules',
      noDataColor: '#00000000',
      gradientStops: [],
      rules: [
        { min: -1, max: 0.2, color: '#c2b280', label: '裸地' },
        { min: 0.2, max: 0.6, color: '#7fbf3f', label: '中覆盖' },
        { min: 0.6, max: null, color: '#1f7a1f', label: '高覆盖' },
      ],
    } satisfies RasterClassificationLayer;

    expect(buildRasterClassificationLegendData(layer)).toEqual({
      mode: 'rules',
      gradientCss: null,
      items: [
        { color: '#c2b280', label: '裸地' },
        { color: '#7fbf3f', label: '中覆盖' },
        { color: '#1f7a1f', label: '高覆盖' },
      ],
    });
  });
});
