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

function buildPixelData(
  bands: SupportedRasterArray[],
  bitsPerSample: number[],
  sampleFormat: number[],
  width: number,
  height: number,
): Uint8Array {
  const pixelCount = width * height;
  const bytesPerPixel = bitsPerSample.reduce((sum, bits) => sum + getBytesPerSample(bits), 0);
  const buffer = new ArrayBuffer(pixelCount * bytesPerPixel);
  const view = new DataView(buffer);
  let offset = 0;

  bands.forEach((band) => {
    if (band.length !== pixelCount) {
      throw new Error('导出 GeoTIFF 时波段数据长度与窗口尺寸不一致');
    }
  });

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    for (let bandIndex = 0; bandIndex < bands.length; bandIndex += 1) {
      const value = bands[bandIndex]?.[pixelIndex] ?? 0;
      writeSampleValue(
        view,
        offset,
        value,
        sampleFormat[bandIndex] ?? sampleFormat[0] ?? 1,
        bitsPerSample[bandIndex] ?? bitsPerSample[0] ?? 8,
      );
      offset += getBytesPerSample(bitsPerSample[bandIndex] ?? bitsPerSample[0] ?? 8);
    }
  }

  return new Uint8Array(buffer);
}

export function writeGeoTiffBuffer(options: GeoTiffWriteOptions): ArrayBuffer {
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
  } = options;

  if (bands.length !== samplesPerPixel) {
    throw new Error('导出 GeoTIFF 时波段数量与 SamplesPerPixel 不一致');
  }

  const pixelData = buildPixelData(bands, bitsPerSample, sampleFormat, width, height);

  const tags: TiffTag[] = [
    createInlineLongTag(256, width),
    createInlineLongTag(257, height),
    createShortArrayTag(258, bitsPerSample),
    createInlineShortTag(259, 1),
    createInlineShortTag(262, photometricInterpretation),
    createInlineLongTag(273, 0),
    createInlineShortTag(277, samplesPerPixel),
    createInlineLongTag(278, height),
    createInlineLongTag(279, pixelData.byteLength),
    createInlineShortTag(284, 1),
    createShortArrayTag(339, sampleFormat),
    createDoubleArrayTag(33550, modelPixelScale),
    createDoubleArrayTag(33922, modelTiepoint),
  ];

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

  tags.sort((left, right) => left.tag - right.tag);

  const ifdOffset = 8;
  const entryCount = tags.length;
  const ifdByteLength = 2 + entryCount * 12 + 4;
  let nextDataOffset = ensureEvenOffset(ifdOffset + ifdByteLength);
  const offsetTags = new Map<number, number>();

  for (const tag of tags) {
    if ('data' in tag) {
      nextDataOffset = ensureEvenOffset(nextDataOffset);
      offsetTags.set(tag.tag, nextDataOffset);
      nextDataOffset += tag.data.byteLength;
    }
  }

  nextDataOffset = ensureEvenOffset(nextDataOffset);
  const pixelDataOffset = nextDataOffset;
  const totalByteLength = pixelDataOffset + pixelData.byteLength;
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
      view.setUint32(entryOffset + 8, offsetTags.get(tag.tag) ?? 0, true);
      return;
    }

    if (tag.type === 3) {
      view.setUint16(entryOffset + 8, tag.inlineValue, true);
      view.setUint16(entryOffset + 10, 0, true);
      return;
    }

    view.setUint32(entryOffset + 8, tag.inlineValue, true);
  });

  view.setUint32(ifdOffset + 2 + entryCount * 12, 0, true);

  for (const tag of tags) {
    if ('data' in tag) {
      const offset = offsetTags.get(tag.tag) ?? 0;
      bytes.set(tag.data, offset);
    }
  }

  bytes.set(pixelData, pixelDataOffset);

  return buffer;
}
