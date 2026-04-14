import { describe, expect, it } from 'vitest';

import {
  applyFenceNoDataMask,
  buildGeoTiffExportMetadata,
  getPixelWindowFromFenceBoundingBox,
  pickExportNoDataValue,
} from '@/shared/geo/geotiffExport';

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

  it('throws when the fence bbox does not intersect the raster extent', () => {
    expect(() =>
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

describe('applyFenceNoDataMask', () => {
  it('writes NoData to pixels whose centers fall outside the fence', () => {
    const band = new Float32Array([1, 2, 3, 4]);

    const masked = applyFenceNoDataMask({
      bands: [band],
      window: [0, 0, 2, 2],
      width: 2,
      height: 2,
      origin: [0, 2, 0],
      resolution: [1, -1, 0],
      fenceRings: [[[0, 2], [1, 2], [1, 1], [0, 1], [0, 2]]],
      noDataValue: -9999,
    });

    expect(Array.from(masked[0])).toEqual([1, -9999, -9999, -9999]);
    expect(masked[0]).toBeInstanceOf(Float32Array);
    expect(masked[0]).not.toBe(band);
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
