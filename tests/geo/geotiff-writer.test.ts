import { fromArrayBuffer } from 'geotiff';
import { describe, expect, it } from 'vitest';

import {
  EMBEDDED_SNAPSHOT_PREFIX,
  decodeEmbeddedSnapshot,
  encodeEmbeddedSnapshot,
  exportProjectSnapshot,
} from '@/features/project/projectSnapshot';
import { DEFLATE_COMPRESSION, writeGeoTiffBuffer, writeGeoTiffBufferAsync } from '@/shared/geo/geotiffWriter';
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

  it('does not mark real data bands as ExtraSamples on a multi-band image', async () => {
    // 5 波段影像（蓝/绿/红/红边/近红外）：一个附加样本都不该声明，
    // 否则读取端会把数据波段数算成 1
    const bands = Array.from({ length: 5 }, (_, index) => new Float32Array([index + 1]));
    const buffer = writeGeoTiffBuffer({
      width: 1,
      height: 1,
      bands,
      bitsPerSample: [32, 32, 32, 32, 32],
      sampleFormat: [3, 3, 3, 3, 3],
      samplesPerPixel: 5,
      photometricInterpretation: 1,
      modelPixelScale: [1, 1, 0],
      modelTiepoint: [0, 0, 0, 0, 0, 0],
    });

    const image = await (await fromArrayBuffer(buffer)).getImage();
    const extraSamples = countExtraSamples(image.getFileDirectory());

    expect(extraSamples).toBe(0);
    expect(resolveDataBandCount(image.getSamplesPerPixel(), extraSamples)).toBe(5);
  });
});

describe('writeGeoTiffBufferAsync', () => {
  /** 每个 8x8 块取常量：模拟处方图「按网格取同一值」的高度重复结构 */
  function buildRepetitiveBand(width: number, height: number): Float32Array {
    const band = new Float32Array(width * height);
    for (let row = 0; row < height; row += 1) {
      for (let col = 0; col < width; col += 1) {
        const block = Math.floor(row / 8) * Math.ceil(width / 8) + Math.floor(col / 8);
        band[row * width + col] = block + 0.5;
      }
    }
    return band;
  }

  it('writes a deflate-compressed geotiff that reads back correctly and stays smaller', async () => {
    const width = 64;
    const height = 64;
    const band = buildRepetitiveBand(width, height);
    const options = {
      width,
      height,
      bands: [band],
      bitsPerSample: [32],
      sampleFormat: [3],
      samplesPerPixel: 1,
      photometricInterpretation: 1,
      modelPixelScale: [1, 1, 0],
      modelTiepoint: [0, 0, 0, 0, height, 0],
      gdalNoData: '-9999',
    };

    const compressed = await writeGeoTiffBufferAsync(options);
    const uncompressed = writeGeoTiffBuffer(options);

    expect(compressed.byteLength).toBeLessThan(uncompressed.byteLength);

    const image = await (await fromArrayBuffer(compressed)).getImage();
    const rasters = (await image.readRasters({ interleave: false })) as unknown as Float32Array[];

    expect(image.fileDirectory.Compression).toBe(DEFLATE_COMPRESSION);
    expect(image.getWidth()).toBe(width);
    expect(image.getHeight()).toBe(height);
    expect(image.getGDALNoData()).toBe(-9999);
    expect(Array.from(rasters[0].slice(0, width * height))).toEqual(Array.from(band));
  });

  it('falls back to an uncompressed file when compression is unavailable', async () => {
    const band = buildRepetitiveBand(16, 16);
    const options = {
      width: 16,
      height: 16,
      bands: [band],
      bitsPerSample: [32],
      sampleFormat: [3],
      samplesPerPixel: 1,
      photometricInterpretation: 1,
      modelPixelScale: [1, 1, 0],
      modelTiepoint: [0, 0, 0, 0, 16, 0],
    };

    const buffer = await writeGeoTiffBufferAsync(options, async () => null);
    const image = await (await fromArrayBuffer(buffer)).getImage();
    const rasters = (await image.readRasters({ interleave: false })) as unknown as Float32Array[];

    expect(image.fileDirectory.Compression).toBe(1);
    expect(Array.from(rasters[0].slice(0, 16 * 16))).toEqual(Array.from(band));
  });

  it('keeps the raw payload when compression would make the file larger', async () => {
    const band = buildRepetitiveBand(8, 8);
    const options = {
      width: 8,
      height: 8,
      bands: [band],
      bitsPerSample: [32],
      sampleFormat: [3],
      samplesPerPixel: 1,
      photometricInterpretation: 1,
      modelPixelScale: [1, 1, 0],
      modelTiepoint: [0, 0, 0, 0, 8, 0],
    };

    const buffer = await writeGeoTiffBufferAsync(options, async (raw) => new Uint8Array(raw.byteLength + 16));
    const image = await (await fromArrayBuffer(buffer)).getImage();

    expect(image.fileDirectory.Compression).toBe(1);
  });
});

describe('短 ASCII tag 值（GDAL_NODATA）', () => {
  function buildOptions(gdalNoData: string) {
    return {
      width: 8,
      height: 8,
      bands: [new Float32Array(64).fill(0.5)],
      bitsPerSample: [32],
      sampleFormat: [3],
      samplesPerPixel: 1,
      photometricInterpretation: 1,
      modelPixelScale: [1, 1, 0] as [number, number, number],
      modelTiepoint: [0, 0, 0, 0, 8, 0] as [number, number, number, number, number, number],
      gdalNoData,
    };
  }

  // 不超过 4 字节的值按 TIFF 规范必须内联存放在 value 字段；
  // 写成偏移会让读取端把偏移字节当成字符串。nodata 为 0 的影像（很常见）就命中这个坑。
  for (const gdalNoData of ['0', '-1', 'NaN', '-9999']) {
    it(`写入并读回 ${JSON.stringify(gdalNoData)}`, async () => {
      const image = await (await fromArrayBuffer(writeGeoTiffBuffer(buildOptions(gdalNoData)))).getImage();
      expect(image.fileDirectory.GDAL_NODATA).toBe(`${gdalNoData}\u0000`);
    });
  }

  it('压缩路径同样正确', async () => {
    const image = await (await fromArrayBuffer(await writeGeoTiffBufferAsync(buildOptions('0')))).getImage();
    expect(image.fileDirectory.GDAL_NODATA).toBe('0\u0000');
    expect(image.getGDALNoData()).toBe(0);
  });
});
