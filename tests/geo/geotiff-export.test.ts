import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMetricTransform } from '@/shared/geo/crs';
import {
  applyGridAggregationToFenceWindowBands,
  applyGridNoDataMask,
  buildGridAggregationFromFenceWindow,
  buildGridAggregationFromFenceWindowAsync,
  buildGeoTiffExportMetadata,
  getPixelWindowFromFenceBoundingBox,
  pickExportNoDataValue,
  readGeoTiffFenceWindow,
} from '@/shared/geo/geotiffExport';

const { fromArrayBufferMock } = vi.hoisted(() => ({
  fromArrayBufferMock: vi.fn(),
}));

vi.mock('geotiff', () => ({
  fromArrayBuffer: fromArrayBufferMock,
}));

beforeEach(() => {
  fromArrayBufferMock.mockReset();
});

describe('getPixelWindowFromFenceBoundingBox', () => {
  it('converts fence bbox into a clamped pixel window', () => {
    expect(
      getPixelWindowFromFenceBoundingBox({
        bbox: [110, 150, 140, 180],
        rasterWidth: 10,
        rasterHeight: 10,
        origin: [100, 200, 0],
        resolution: [10, -10, 0],
      }),
    ).toEqual([1, 2, 4, 5]);
  });

  it('handles south-up rasters whose resolutionY is positive', () => {
    // south-up：行号随 y 增大而增大。若按 north-up 推导会得到 startRow > endRow 的退化窗口。
    expect(
      getPixelWindowFromFenceBoundingBox({
        bbox: [10, 20, 30, 50],
        rasterWidth: 10,
        rasterHeight: 10,
        origin: [0, 0, 0],
        resolution: [10, 10, 0],
      }),
    ).toEqual([1, 2, 3, 5]);
  });

  it('throws when the fence bbox does not intersect the raster extent', () => {    expect(() =>
      getPixelWindowFromFenceBoundingBox({
        bbox: [300, 300, 320, 320],
        rasterWidth: 10,
        rasterHeight: 10,
        origin: [100, 200, 0],
        resolution: [10, -10, 0],
      }),
    ).toThrow('围栏超出影像范围');
  });
});

describe('readGeoTiffFenceWindow', () => {
  it('reads the original GeoTIFF fence window for downstream aggregation', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'demo.tif', { type: 'image/tiff' });
    const image = {
      getWidth: () => 10,
      getHeight: () => 10,
      getOrigin: () => [100, 200, 0] as [number, number, number],
      getResolution: () => [10, -10, 0] as [number, number, number],
      getSamplesPerPixel: () => 2,
      getBitsPerSample: (index = 0) => [32, 16][index],
      getSampleFormat: (index = 0) => [3, 1][index],
      getGDALNoData: () => -9999,
      getFileDirectory: () => ({
        PhotometricInterpretation: 1,
      }),
      readRasters: vi.fn().mockResolvedValue([new Float32Array([1, 2, 3, 4])]),
    };

    fromArrayBufferMock.mockResolvedValue({
      getImage: vi.fn().mockResolvedValue(image),
    });

    const result = await readGeoTiffFenceWindow({
      file,
      fenceRings: [
        [
          [110, 180],
          [130, 180],
          [130, 160],
          [110, 160],
          [110, 180],
        ],
      ],
      samples: [0],
    });

    expect(image.readRasters).toHaveBeenCalledWith({
      window: [1, 2, 3, 4],
      interleave: false,
      samples: [0],
    });
    expect(result).toMatchObject({
      window: [1, 2, 3, 4],
      width: 2,
      height: 2,
      origin: [100, 200, 0],
      resolution: [10, -10, 0],
      sourceNoDataValue: -9999,
      bitsPerSample: [32],
      sampleFormat: [3],
      samplesPerPixel: 1,
    });
    expect(result.bands[0]).toEqual(new Float32Array([1, 2, 3, 4]));
  });
});

describe('buildGridAggregationFromFenceWindow', () => {
  it('aggregates the primary band from the original raster window into grid means', () => {
    const aggregation = buildGridAggregationFromFenceWindow({
      bands: [new Float32Array([1, 3, 5, 7])],
      window: [0, 0, 2, 2],
      width: 2,
      height: 2,
      origin: [0, 2, 0],
      resolution: [1, -1, 0],
      fenceRings: [
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 2],
          [0, 0],
        ],
      ],
      gridCellWidth: 2,
      gridCellHeight: 2,
      sourceNoDataValue: null,
    });

    expect(aggregation.cellsById['r0-c0']).toMatchObject({
      pixelCount: 4,
      validPixelCount: 4,
      sumValue: 16,
      meanValue: 4,
      outputValue: 4,
    });
  });

  it('aggregates geographic raster windows by metric cell size when metricTransform is provided', () => {
    const metricTransform = createMetricTransform({
      crsCode: 'EPSG:4326',
      boundingBox: [119.420001, 36.510001, 119.420901, 36.510601],
    });

    const aggregation = buildGridAggregationFromFenceWindow({
      bands: [new Float32Array([1, 3, 5, 7])],
      window: [0, 0, 2, 2],
      width: 2,
      height: 2,
      origin: [119.420001, 36.510601, 0],
      resolution: [0.00045, -0.0003, 0],
      fenceRings: [
        [
          [119.420001, 36.510001],
          [119.420901, 36.510001],
          [119.420901, 36.510601],
          [119.420001, 36.510601],
          [119.420001, 36.510001],
        ],
      ],
      metricTransform,
      gridCellWidth: 10,
      gridCellHeight: 10,
      sourceNoDataValue: null,
    });

    expect(Object.keys(aggregation.cellsById)).toHaveLength(4);
    expect(Object.values(aggregation.cellsById).map((cell) => cell.meanValue)).toEqual([1, 3, 5, 7]);
  });

  it('matches the synchronous aggregation result when using the async fence-window path', async () => {
    const yieldControl = vi.fn(async () => undefined);
    const input: Parameters<typeof buildGridAggregationFromFenceWindow>[0] = {
      bands: [new Float32Array([1, 3, 5, 7, 9, 11])],
      window: [0, 0, 3, 2],
      width: 3,
      height: 2,
      origin: [0, 2, 0],
      resolution: [1, -1, 0],
      fenceRings: [
        [
          [0, 0],
          [3, 0],
          [3, 2],
          [0, 2],
          [0, 0],
        ],
      ],
      gridCellWidth: 1,
      gridCellHeight: 1,
      sourceNoDataValue: null,
    };

    const syncAggregation = buildGridAggregationFromFenceWindow(input);
    const asyncAggregation = await buildGridAggregationFromFenceWindowAsync(input, {
      rowsPerChunk: 1,
      yieldControl,
    });

    expect(asyncAggregation).toEqual(syncAggregation);
    expect(yieldControl).toHaveBeenCalledTimes(1);
  });
});

describe('applyGridAggregationToFenceWindowBands', () => {  it('rewrites hit-cell pixels to the aggregated grid value and keeps others as nodata', () => {
    const result = applyGridAggregationToFenceWindowBands({
      bands: [new Float32Array([1, 3, 5, 7])],
      window: [0, 0, 2, 2],
      width: 2,
      height: 2,
      origin: [0, 2, 0],
      resolution: [1, -1, 0],
      fenceRings: [
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 2],
          [0, 0],
        ],
      ],
      gridCellWidth: 2,
      gridCellHeight: 2,
      sourceNoDataValue: null,
      noDataValue: -9999,
    });

    expect(Array.from(result.bands[0])).toEqual([4, 4, 4, 4]);
    expect(result.aggregation.cellsById['r0-c0']?.meanValue).toBe(4);
    expect(result.maskedPixelCount).toBe(0);
  });

  it('float32 输出时把 NoData 哨兵同步舍入，避免 tag 与像素值不一致', () => {
    // 0.1 无法被 Float32 精确表示：像素里存的是 Math.fround(0.1)，
    // 返回给写 tag 的 noDataValue 也必须是同一个值，否则下游按等值比较认不出掩膜像元
    const result = applyGridAggregationToFenceWindowBands({
      bands: [new Float32Array([1, 3, 5, 7])],
      window: [0, 0, 2, 2],
      width: 2,
      height: 2,
      origin: [0, 2, 0],
      resolution: [1, -1, 0],
      // 只覆盖上半部分，下半部分留给掩膜
      fenceRings: [
        [
          [0, 1],
          [2, 1],
          [2, 2],
          [0, 2],
          [0, 1],
        ],
      ],
      gridCellWidth: 1,
      gridCellHeight: 1,
      sourceNoDataValue: null,
      noDataValue: 0.1,
      outputType: 'float32',
    });

    expect(result.bands[0]).toBeInstanceOf(Float32Array);
    expect(result.noDataValue).toBe(Math.fround(0.1));
    // 掩膜像元写入的就是舍入后的哨兵（与 tag 同值）
    expect(Array.from(result.bands[0]).filter((value) => value === Math.fround(0.1)).length).toBeGreaterThan(0);
    expect(result.maskedPixelCount).toBeGreaterThan(0);
  });

  it('keeps geographic pixels in separate metric cells instead of collapsing them during rewrite', () => {
    const metricTransform = createMetricTransform({
      crsCode: 'EPSG:4326',
      boundingBox: [119.420001, 36.510001, 119.420901, 36.510601],
    });

    const result = applyGridAggregationToFenceWindowBands({
      bands: [new Float32Array([1, 3, 5, 7])],
      window: [0, 0, 2, 2],
      width: 2,
      height: 2,
      origin: [119.420001, 36.510601, 0],
      resolution: [0.00045, -0.0003, 0],
      fenceRings: [
        [
          [119.420001, 36.510001],
          [119.420901, 36.510001],
          [119.420901, 36.510601],
          [119.420001, 36.510601],
          [119.420001, 36.510001],
        ],
      ],
      metricTransform,
      gridCellWidth: 10,
      gridCellHeight: 10,
      sourceNoDataValue: null,
      noDataValue: -9999,
    });

    expect(Array.from(result.bands[0])).toEqual([1, 3, 5, 7]);
    expect(result.maskedPixelCount).toBe(0);
  });
});

describe('applyGridNoDataMask', () => {
  it('writes NoData to pixels whose centers fall outside the selected grid cells', () => {
    const band = new Float32Array([1, 2, 3, 4]);

    const masked = applyGridNoDataMask({
      bands: [band],
      window: [0, 0, 2, 2],
      width: 2,
      height: 2,
      origin: [0, 2, 0],
      resolution: [1, -1, 0],
      fenceRings: [
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 2],
          [0, 0],
        ],
        [
          [0, 0],
          [2, 0],
          [2, 1],
          [0, 1],
          [0, 0],
        ],
        [
          [1, 1],
          [2, 1],
          [2, 2],
          [1, 2],
          [1, 1],
        ],
      ],
      gridCellWidth: 1,
      gridCellHeight: 1,
      noDataValue: -9999,
    });

    expect(Array.from(masked.bands[0])).toEqual([1, -9999, -9999, -9999]);
    expect(masked.maskedPixelCount).toBe(3);
    expect(masked.bands[0]).toBeInstanceOf(Float32Array);
    expect(masked.bands[0]).not.toBe(band);
  });
});

describe('buildGeoTiffExportMetadata', () => {
  it('builds geotiff writer metadata from clipped raster properties', () => {
    expect(
      buildGeoTiffExportMetadata({
        width: 3,
        height: 2,
        origin: [110, 180, 0],
        resolution: [10, -10, 0],
        bitsPerSample: [32],
        sampleFormat: [3],
        samplesPerPixel: 1,
        geoKeys: {
          GTModelTypeGeoKey: 1,
          ProjectedCSTypeGeoKey: 4549,
          GTCitationGeoKey: 'EPSG:4549',
        },
        noDataValue: -9999,
      }),
    ).toMatchObject({
      ImageWidth: 3,
      ImageLength: 2,
      SamplesPerPixel: 1,
      BitsPerSample: [32],
      SampleFormat: [3],
      ModelPixelScale: [10, 10, 0],
      ModelTiepoint: [0, 0, 0, 110, 180, 0],
      GDAL_NODATA: '-9999',
      ProjectedCSTypeGeoKey: 4549,
    });
  });
});

describe('pickExportNoDataValue', () => {
  it('reuses source nodata when it exists', () => {
    expect(
      pickExportNoDataValue({
        sourceNoDataValue: -9999,
        sampleFormat: [3],
        bitsPerSample: [32],
        bands: [new Float32Array([0.1, 0.2, 0.9])],
      }),
    ).toBe(-9999);
  });

  it('falls back to a safe sentinel for float rasters', () => {
    expect(
      pickExportNoDataValue({
        sourceNoDataValue: null,
        sampleFormat: [3],
        bitsPerSample: [32],
        bands: [new Float32Array([0.1, 0.2, 0.9])],
      }),
    ).toBe(-3.4028234663852886e38);
  });
});
