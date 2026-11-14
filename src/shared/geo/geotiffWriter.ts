type SupportedRasterArray =
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Float32Array
  | Float64Array;

type GeoTiffWriteOptions = {
  width: number;
  height: number;
  bands: SupportedRasterArray[];
  bitsPerSample: number[];
  sampleFormat: number[];
  samplesPerPixel: number;
  photometricInterpretation?: number;
  modelPixelScale: number[] | Float64Array;
  modelTiepoint: number[] | Float64Array;
  geoKeyDirectory?: number[] | Uint16Array;
  geoAsciiParams?: string;
  geoDoubleParams?: number[] | Float64Array;
  gdalNoData?: string | null;
  /**
   * 写入 ImageDescription（tag 270，ASCII）。
   * 本工具用它内嵌工程配方；注意会覆盖源文件的同名 tag。
   */
  imageDescription?: string;
  /**
   * 尾部的附加波段数量（写入 ExtraSamples, tag 338）。
   *
   * 必须由调用方显式给出：`samplesPerPixel - 1` 只对单波段灰度（PhotometricInterpretation=1）
   * 成立；RGB 源追加一个处方波段时 SamplesPerPixel=4 但附加波段只有 1 个，
   * 若按 `samplesPerPixel - 1` 推断会写出 3 个附加波段并让读取端算错数据波段数。
   * 缺省时退回「仅单波段灰度多波段」的旧推断，仅为兼容旧调用方。
   */
  extraSamplesCount?: number;
};

type TiffFieldType = 2 | 3 | 4 | 12;

type InlineTag = {
  tag: number;
  type: TiffFieldType;
  count: number;
  inlineValue: number;
};

type OffsetTag = {
  tag: number;
  type: TiffFieldType;
  count: number;
  data: Uint8Array;
};

type TiffTag = InlineTag | OffsetTag;

const TIFF_TYPE_SIZES: Record<TiffFieldType, number> = {
  2: 1,
  3: 2,
  4: 4,
  12: 8,
};

function ensureEvenOffset(offset: number): number {
  return offset % 2 === 0 ? offset : offset + 1;
}

function buildAsciiBytes(value: string): Uint8Array {
  const normalized = value.endsWith('\0') ? value : `${value}\0`;
  return new TextEncoder().encode(normalized);
}

function buildShortBytes(values: number[] | Uint16Array): Uint8Array {
  const normalized = Array.from(values);
  const buffer = new ArrayBuffer(normalized.length * 2);
  const view = new DataView(buffer);

  normalized.forEach((value, index) => {
    view.setUint16(index * 2, value, true);
  });

  return new Uint8Array(buffer);
}

function buildDoubleBytes(values: number[] | Float64Array): Uint8Array {
  const normalized = Array.from(values);
  const buffer = new ArrayBuffer(normalized.length * 8);
  const view = new DataView(buffer);

  normalized.forEach((value, index) => {
    view.setFloat64(index * 8, value, true);
  });

  return new Uint8Array(buffer);
}

function createInlineShortTag(tag: number, value: number): InlineTag {
  return {
    tag,
    type: 3,
    count: 1,
    inlineValue: value,
  };
}

function createInlineLongTag(tag: number, value: number): InlineTag {
  return {
    tag,
    type: 4,
    count: 1,
    inlineValue: value,
  };
}

function createShortArrayTag(tag: number, values: number[] | Uint16Array): TiffTag {
  const normalized = Array.from(values);

  if (normalized.length === 1) {
    return createInlineShortTag(tag, normalized[0] ?? 0);
  }

  // TIFF 规范：2 个 SHORT = 4 字节，恰好可以内联存入 IFD entry 的 value 字段
  // 必须内联，否则读取端会把 value 字段当作内联数据而非 offset 指针，导致解析错误
  if (normalized.length === 2) {
    return {
      tag,
      type: 3,
      count: 2,
      inlineValue: ((normalized[0] ?? 0) & 0xFFFF) | (((normalized[1] ?? 0) & 0xFFFF) << 16),
    };
  }

  return {
    tag,
    type: 3,
    count: normalized.length,
    data: buildShortBytes(normalized),
  };
}

function createDoubleArrayTag(tag: number, values: number[] | Float64Array): OffsetTag {
  const normalized = Array.from(values);

  return {
    tag,
    type: 12,
    count: normalized.length,
    data: buildDoubleBytes(normalized),
  };
}

function createAsciiTag(tag: number, value: string): OffsetTag {
  const data = buildAsciiBytes(value);

  return {
    tag,
    type: 2,
    count: data.byteLength,
    data,
  };
}

function getBytesPerSample(bitsPerSample: number): number {
  if (bitsPerSample % 8 !== 0) {
    throw new Error(`暂不支持非整字节像元位深：${bitsPerSample}`);
  }

  return bitsPerSample / 8;
}

function writeSampleValue(
  view: DataView,
  offset: number,
  value: number,
  sampleFormat: number,
  bitsPerSample: number,
): void {
  if (sampleFormat === 1) {
    if (bitsPerSample === 8) {
      view.setUint8(offset, value);
      return;
    }
    if (bitsPerSample === 16) {
      view.setUint16(offset, value, true);
      return;
    }
    if (bitsPerSample === 32) {
      view.setUint32(offset, value, true);
      return;
    }
  }

  if (sampleFormat === 2) {
    if (bitsPerSample === 8) {
      view.setInt8(offset, value);
      return;
    }
    if (bitsPerSample === 16) {
      view.setInt16(offset, value, true);
      return;
    }
    if (bitsPerSample === 32) {
      view.setInt32(offset, value, true);
      return;
    }
  }

  if (sampleFormat === 3) {
    if (bitsPerSample === 32) {
      view.setFloat32(offset, value, true);
      return;
    }
    if (bitsPerSample === 64) {
      view.setFloat64(offset, value, true);
      return;
    }
  }

  throw new Error(`暂不支持的像元格式组合：SampleFormat=${sampleFormat}, BitsPerSample=${bitsPerSample}`);
}

/**
 * 校验波段长度并计算像元数据区的字节数。
 */
function computePixelDataByteLength(
  bands: SupportedRasterArray[],
  bitsPerSample: number[],
  width: number,
  height: number,
): number {
  const pixelCount = width * height;

  bands.forEach((band) => {
    if (band.length !== pixelCount) {
      throw new Error('导出 GeoTIFF 时波段数据长度与窗口尺寸不一致');
    }
  });

  const bytesPerPixel = bitsPerSample.reduce((sum, bits) => sum + getBytesPerSample(bits), 0);
  return pixelCount * bytesPerPixel;
}

/**
 * 把像元数据直接写入目标缓冲区的指定偏移。
 *
 * 与旧实现（先建一整块像元缓冲、再拷进文件缓冲）相比，省掉了一份等大的中间缓冲；
 * 全部波段都是 32 位浮点时改用 Float32Array 视图写入，免去逐样本的 DataView 调用。
 */
function writePixelDataInto(input: {
  bytes: Uint8Array;
  view: DataView;
  offset: number;
  bands: SupportedRasterArray[];
  bitsPerSample: number[];
  sampleFormat: number[];
  pixelCount: number;
}): void {
  const { bytes, view, offset, bands, bitsPerSample, sampleFormat, pixelCount } = input;
  const uniformFloat32 =
    offset % 4 === 0 &&
    bands.every(
      (_band, bandIndex) =>
        (sampleFormat[bandIndex] ?? 1) === 3 && (bitsPerSample[bandIndex] ?? 8) === 32,
    );

  if (uniformFloat32) {
    const target = new Float32Array(bytes.buffer, offset, pixelCount * bands.length);

    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      const targetOffset = pixelIndex * bands.length;

      for (let bandIndex = 0; bandIndex < bands.length; bandIndex += 1) {
        target[targetOffset + bandIndex] = bands[bandIndex]?.[pixelIndex] ?? 0;
      }
    }

    return;
  }

  let sampleOffset = offset;

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    for (let bandIndex = 0; bandIndex < bands.length; bandIndex += 1) {
      const value = bands[bandIndex]?.[pixelIndex] ?? 0;
      writeSampleValue(
        view,
        sampleOffset,
        value,
        sampleFormat[bandIndex] ?? sampleFormat[0] ?? 1,
        bitsPerSample[bandIndex] ?? bitsPerSample[0] ?? 8,
      );
      sampleOffset += getBytesPerSample(bitsPerSample[bandIndex] ?? bitsPerSample[0] ?? 8);
    }
  }
}

/** Deflate 压缩（TIFF Compression = 8），各类 GIS/读取端通用 */
export const DEFLATE_COMPRESSION = 8;

/**
 * 像元数据的写出方式：
 * 同步路径直接写进文件缓冲（只有一份缓冲）；压缩路径写入已压缩好的字节。
 */
type PixelDataWriter = {
  byteLength: number;
  compression: number;
  write: (bytes: Uint8Array, view: DataView, offset: number) => void;
};

/**
 * TIFF 规定：不超过 4 字节的 tag 值直接内联存放在 IFD 条目的 value 字段里，
 * 不是"value 字段存偏移"。写偏移会让合规读取端把偏移的字节当成值——
 * 短字符串（如 GDAL_NODATA 的 "NaN"、"1"）因此会被读成乱码。
 */
function isInlineTagData(tag: TiffTag): boolean {
  return 'data' in tag && tag.data.byteLength <= 4;
}

function assembleGeoTiff(options: GeoTiffWriteOptions, pixelData: PixelDataWriter): ArrayBuffer {
  const {
    width,
    height,
    bands,
    bitsPerSample,
    sampleFormat,
    samplesPerPixel,
    photometricInterpretation = samplesPerPixel === 3 ? 2 : 1,
    modelPixelScale,
    modelTiepoint,
    geoKeyDirectory,
    geoAsciiParams,
    geoDoubleParams,
    gdalNoData,
    imageDescription,
    extraSamplesCount,
  } = options;

  if (bands.length !== samplesPerPixel) {
    throw new Error('导出 GeoTIFF 时波段数量与 SamplesPerPixel 不一致');
  }

  const pixelDataByteLength = pixelData.byteLength;

  const tags: TiffTag[] = [
    createInlineLongTag(256, width),
    createInlineLongTag(257, height),
    createShortArrayTag(258, bitsPerSample),
    createInlineShortTag(259, pixelData.compression),
    createInlineShortTag(262, photometricInterpretation),
    createInlineLongTag(273, 0),
    createInlineShortTag(277, samplesPerPixel),
    createInlineLongTag(278, height),
    createInlineLongTag(279, pixelDataByteLength),
    createInlineShortTag(284, 1),
    createShortArrayTag(339, sampleFormat),
    createDoubleArrayTag(33550, modelPixelScale),
    createDoubleArrayTag(33922, modelTiepoint),
  ];

  // 只对"1 个数据波段 + 1 个追加波段"的历史调用方做推断（SamplesPerPixel = 2）。
  // 三个波段以上的多波段影像不应声明附加样本：那些是真实数据波段，
  // 把它们标成 ExtraSamples 会让读取端把数据波段数算成 1。
  const inferredExtraSamples =
    samplesPerPixel === 2 && photometricInterpretation === 1 ? 1 : 0;
  const requestedExtraSamples =
    typeof extraSamplesCount === 'number' && Number.isFinite(extraSamplesCount)
      ? Math.max(0, Math.floor(extraSamplesCount))
      : inferredExtraSamples;
  const extraSamples = Math.min(requestedExtraSamples, Math.max(0, samplesPerPixel - 1));

  if (extraSamples > 0) {
    const extraSamplesTags = Array.from({ length: extraSamples }, () => 0); // 0 = Unspecified Data
    tags.push(createShortArrayTag(338, extraSamplesTags));
  }

  if (geoKeyDirectory && geoKeyDirectory.length > 0) {
    tags.push(createShortArrayTag(34735, geoKeyDirectory));
  }

  if (geoDoubleParams && geoDoubleParams.length > 0) {
    tags.push(createDoubleArrayTag(34736, geoDoubleParams));
  }

  if (geoAsciiParams && geoAsciiParams.length > 0) {
    tags.push(createAsciiTag(34737, geoAsciiParams));
  }

  if (gdalNoData && gdalNoData.length > 0) {
    tags.push(createAsciiTag(42113, gdalNoData));
  }

  if (imageDescription && imageDescription.length > 0) {
    tags.push(createAsciiTag(270, imageDescription));
  }

  tags.sort((left, right) => left.tag - right.tag);

  const ifdOffset = 8;
  const entryCount = tags.length;
  const ifdByteLength = 2 + entryCount * 12 + 4;
  let nextDataOffset = ensureEvenOffset(ifdOffset + ifdByteLength);
  const offsetTags = new Map<number, number>();

  for (const tag of tags) {
    if ('data' in tag && !isInlineTagData(tag)) {
      nextDataOffset = ensureEvenOffset(nextDataOffset);
      offsetTags.set(tag.tag, nextDataOffset);
      nextDataOffset += tag.data.byteLength;
    }
  }

  // TIFF 只要求字对齐（2 字节）；这里对齐到 4 字节，
  // 让像元数据可以直接用 Float32Array 视图写入（视图要求字节偏移是元素大小的整数倍）。
  nextDataOffset = ensureEvenOffset(nextDataOffset);
  if (nextDataOffset % 4 !== 0) {
    nextDataOffset += 4 - (nextDataOffset % 4);
  }

  const pixelDataOffset = nextDataOffset;
  const totalByteLength = pixelDataOffset + pixelDataByteLength;
  const buffer = new ArrayBuffer(totalByteLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  bytes[0] = 0x49;
  bytes[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);
  view.setUint16(ifdOffset, entryCount, true);

  tags.forEach((tag, index) => {
    const entryOffset = ifdOffset + 2 + index * 12;
    view.setUint16(entryOffset, tag.tag, true);
    view.setUint16(entryOffset + 2, tag.type, true);
    view.setUint32(entryOffset + 4, tag.count, true);

    if (tag.tag === 273) {
      view.setUint32(entryOffset + 8, pixelDataOffset, true);
      return;
    }

    if ('data' in tag) {
      if (isInlineTagData(tag)) {
        const inline = new Uint8Array(4);
        inline.set(tag.data);
        view.setUint32(entryOffset + 8, new DataView(inline.buffer).getUint32(0, true), true);
        return;
      }

      view.setUint32(entryOffset + 8, offsetTags.get(tag.tag) ?? 0, true);
      return;
    }

    // 统一使用 setUint32 写入内联值：
    // - SHORT count=1: 值占低 16 位，高 16 位自然为 0
    // - SHORT count=2: 两个值通过位运算打包在 uint32 中
    // - LONG  count=1: 直接写 uint32
    view.setUint32(entryOffset + 8, tag.inlineValue, true);
  });

  view.setUint32(ifdOffset + 2 + entryCount * 12, 0, true);

  for (const tag of tags) {
    if ('data' in tag && !isInlineTagData(tag)) {
      const offset = offsetTags.get(tag.tag) ?? 0;
      bytes.set(tag.data, offset);
    }
  }

  pixelData.write(bytes, view, pixelDataOffset);

  return buffer;
}

/**
 * 把像元数据交织写进一块独立缓冲（压缩前需要先拿到完整字节）。
 */
function buildInterleavedPixelData(options: GeoTiffWriteOptions): Uint8Array {
  const { bands, bitsPerSample, sampleFormat, width, height } = options;
  const byteLength = computePixelDataByteLength(bands, bitsPerSample, width, height);
  const buffer = new ArrayBuffer(byteLength);
  const bytes = new Uint8Array(buffer);

  writePixelDataInto({
    bytes,
    view: new DataView(buffer),
    offset: 0,
    bands,
    bitsPerSample,
    sampleFormat,
    pixelCount: width * height,
  });

  return bytes;
}

/**
 * 用原生 Deflate 流压缩。
 *
 * 处方图每个网格是常量、网格尺寸远大于像元，重复度极高（实测 49 MB → 0.1 MB）；
 * 即使数据不可压，Deflate 的膨胀也在千分之一量级。
 * API 不可用或出错时返回 null，由调用方退回不压缩。
 */
async function deflateBytes(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream !== 'function') {
    return null;
  }

  try {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    // DOM 类型把 CompressionStream 的可写端标注为 BufferSource，与 Uint8Array 流不匹配；
    // 运行时行为一致，这里只做类型层面的收窄。
    const compressedStream = source.pipeThrough(
      new CompressionStream('deflate') as unknown as TransformStream<Uint8Array, Uint8Array>,
    );
    const compressed = await new Response(compressedStream).arrayBuffer();

    return new Uint8Array(compressed);
  } catch {
    return null;
  }
}

/**
 * 写出不压缩的 GeoTIFF（像元数据直接写进文件缓冲，只有一份缓冲）。
 */
export function writeGeoTiffBuffer(options: GeoTiffWriteOptions): ArrayBuffer {
  const { bands, bitsPerSample, sampleFormat, width, height } = options;

  return assembleGeoTiff(options, {
    byteLength: computePixelDataByteLength(bands, bitsPerSample, width, height),
    compression: 1,
    write: (bytes, view, offset) => {
      writePixelDataInto({
        bytes,
        view,
        offset,
        bands,
        bitsPerSample,
        sampleFormat,
        pixelCount: width * height,
      });
    },
  });
}

/**
 * 写出 Deflate 压缩的 GeoTIFF（Compression = 8）。
 * 压缩不可用或压不小的时候自动退回不压缩，读取端无需区分。
 */
export async function writeGeoTiffBufferAsync(
  options: GeoTiffWriteOptions,
  compress: (bytes: Uint8Array) => Promise<Uint8Array | null> = deflateBytes,
): Promise<ArrayBuffer> {
  const raw = buildInterleavedPixelData(options);
  const compressed = await compress(raw);

  if (compressed && compressed.byteLength < raw.byteLength) {
    return assembleGeoTiff(options, {
      byteLength: compressed.byteLength,
      compression: DEFLATE_COMPRESSION,
      write: (bytes, _view, offset) => {
        bytes.set(compressed, offset);
      },
    });
  }

  return assembleGeoTiff(options, {
    byteLength: raw.byteLength,
    compression: 1,
    write: (bytes, _view, offset) => {
      bytes.set(raw, offset);
    },
  });
}
