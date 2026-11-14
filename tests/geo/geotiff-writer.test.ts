import { fromArrayBuffer } from 'geotiff';
import { describe, expect, it } from 'vitest';

import {
  EMBEDDED_SNAPSHOT_PREFIX,
  decodeEmbeddedSnapshot,
  encodeEmbeddedSnapshot,
  exportProjectSnapshot,
} from '@/features/project/projectSnapshot';
import { writeGeoTiffBuffer } from '@/shared/geo/geotiffWriter';
import { countExtraSamples, resolveDataBandCount } from '@/shared/geo/rasterPreview';

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

  it('round-trips an embedded project payload through the ImageDescription tag', async () => {
    const snapshot = exportProjectSnapshot({
      sourceFile: null,
      sourceLabel: '未选择文件',
      metadata: null,
      fenceRings: [
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 2],
          [0, 0],
        ],
      ],
      grid: { cellSize: 1, rotation: 0, aggregationMode: 'mean' },
      classification: {
        layers: [
          {
            id: 'rules-a',
            label: '规则方案',
            noDataColor: '#00000000',
            visible: true,
            mode: 'rules',
            gradientStops: [],
            rules: [{ min: 0, max: null, color: '#226622', label: '高值', applicationRate: 12.5 }],
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

    const buffer = writeGeoTiffBuffer({
      width: 1,
      height: 1,
      bands: [new Float32Array([1])],
      bitsPerSample: [32],
      sampleFormat: [3],
      samplesPerPixel: 1,
      photometricInterpretation: 1,
      modelPixelScale: [1, 1, 0],
      modelTiepoint: [0, 0, 0, 0, 0, 0],
      gdalNoData: '-9999',
      imageDescription: encodeEmbeddedSnapshot(snapshot),
    });

    const image = await (await fromArrayBuffer(buffer)).getImage();
    const raw = image.getFileDirectory().ImageDescription as string;

    // geotiff.js 会把 ASCII tag 的尾部 NUL 一并返回，解码侧必须能容忍
    expect(raw.startsWith(EMBEDDED_SNAPSHOT_PREFIX)).toBe(true);

    const decoded = decodeEmbeddedSnapshot(raw);
    expect(decoded?.ok).toBe(true);
    if (!decoded || !decoded.ok) return;
    expect(decoded.snapshot).toEqual(snapshot);
  });

  it('declares only the appended band as ExtraSamples for an RGB source', async () => {
    const buffer = writeGeoTiffBuffer({
      width: 1,
      height: 1,
      bands: [
        new Float32Array([1]),
        new Float32Array([2]),
        new Float32Array([3]),
        new Float32Array([80]),
      ],
      bitsPerSample: [32, 32, 32, 32],
      sampleFormat: [3, 3, 3, 3],
      samplesPerPixel: 4,
      photometricInterpretation: 2,
      extraSamplesCount: 1,
      modelPixelScale: [1, 1, 0],
      modelTiepoint: [0, 0, 0, 0, 0, 0],
    });

    const image = await (await fromArrayBuffer(buffer)).getImage();
    const extraSamples = countExtraSamples(image.getFileDirectory());

    // RGB 的 3 个波段是数据波段，只有追加的处方波段是附加波段。
    // 若按 samplesPerPixel - 1 推断会写出 3 个附加波段，读取端就会把数据波段数算成 1。
    expect(image.getSamplesPerPixel()).toBe(4);
    expect(extraSamples).toBe(1);
    expect(resolveDataBandCount(image.getSamplesPerPixel(), extraSamples)).toBe(3);
  });

  it('infers ExtraSamples from samples per pixel for legacy single-band callers', async () => {
    const buffer = writeGeoTiffBuffer({
      width: 1,
      height: 1,
      bands: [new Float32Array([1]), new Float32Array([2])],
      bitsPerSample: [32, 32],
      sampleFormat: [3, 3],
      samplesPerPixel: 2,
      photometricInterpretation: 1,
      modelPixelScale: [1, 1, 0],
      modelTiepoint: [0, 0, 0, 0, 0, 0],
    });

    const image = await (await fromArrayBuffer(buffer)).getImage();
    const extraSamples = countExtraSamples(image.getFileDirectory());

    expect(extraSamples).toBe(1);
    expect(resolveDataBandCount(image.getSamplesPerPixel(), extraSamples)).toBe(1);
  });
});
