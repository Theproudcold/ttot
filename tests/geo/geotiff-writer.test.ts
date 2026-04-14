import { fromArrayBuffer } from 'geotiff';
import { describe, expect, it } from 'vitest';

import { writeGeoTiffBuffer } from '@/shared/geo/geotiffWriter';

describe('writeGeoTiffBuffer', () => {
  it('writes a float32 geotiff that can be read back correctly', async () => {
    const buffer = writeGeoTiffBuffer({
      width: 2,
      height: 2,
      bands: [new Float32Array([1.5, 2.5, 3.5, -9999])],
      bitsPerSample: [32],
      sampleFormat: [3],
      samplesPerPixel: 1,
      photometricInterpretation: 1,
      modelPixelScale: [10, 10, 0],
      modelTiepoint: [0, 0, 0, 110, 180, 0],
      geoKeyDirectory: [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 4549],
      gdalNoData: '-9999',
    });

    const tiff = await fromArrayBuffer(buffer);
    const image = await tiff.getImage();
    const rasters = (await image.readRasters({ interleave: false })) as unknown as [Float32Array];

    expect(image.getWidth()).toBe(2);
    expect(image.getHeight()).toBe(2);
    expect(image.getBitsPerSample()).toBe(32);
    expect(image.getSampleFormat()).toBe(3);
    expect(image.getGDALNoData()).toBe(-9999);
    expect(image.getGeoKeys().ProjectedCSTypeGeoKey).toBe(4549);
    expect(Array.from(rasters[0].slice(0, 4))).toEqual([1.5, 2.5, 3.5, -9999]);
  });

  it('writes an extra float32 sample band that can be read back as prescription values', async () => {
    const buffer = writeGeoTiffBuffer({
      width: 2,
      height: 2,
      bands: [
        new Float32Array([0.1, 0.35, 0.55, 0.8]),
        new Float32Array([50, 80, 80, 120]),
      ],
      bitsPerSample: [32, 32],
      sampleFormat: [3, 3],
      samplesPerPixel: 2,
      photometricInterpretation: 1,
      modelPixelScale: [10, 10, 0],
      modelTiepoint: [0, 0, 0, 110, 180, 0],
      geoKeyDirectory: [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 4549],
      gdalNoData: '-9999',
    });

    const tiff = await fromArrayBuffer(buffer);
    const image = await tiff.getImage();
    const rasters = (await image.readRasters({ interleave: false })) as unknown as [
      Float32Array,
      Float32Array,
    ];

    expect(image.getSamplesPerPixel()).toBe(2);
    expect(image.getBitsPerSample(0)).toBe(32);
    expect(image.getBitsPerSample(1)).toBe(32);
    expect(image.getSampleFormat(0)).toBe(3);
    expect(image.getSampleFormat(1)).toBe(3);
    expect(Array.from(rasters[0])).toEqual(
      expect.arrayContaining([
        expect.closeTo(0.1, 6),
        expect.closeTo(0.35, 6),
        expect.closeTo(0.55, 6),
        expect.closeTo(0.8, 6),
      ]),
    );
    expect(Array.from(rasters[1])).toEqual([50, 80, 80, 120]);
  });
});
