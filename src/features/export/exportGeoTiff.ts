import { fromArrayBuffer, writeArrayBuffer } from 'geotiff';

import {
  applyFenceNoDataMask,
  buildGeoTiffExportMetadata,
  getPixelWindowFromFenceBoundingBox,
  pickExportNoDataValue,
} from '@/shared/geo/geotiffExport';
import { readBlobBuffer } from '@/shared/geo/raster';
import type { FenceFeature } from '@/shared/types/fence';
import type { RasterOrigin, RasterResolution } from '@/shared/types/raster';

type SupportedRasterArray =
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Float32Array
  | Float64Array;

function normalizeRasterBands(rasters: unknown): SupportedRasterArray[] {
  if (!Array.isArray(rasters)) {
    throw new Error('GeoTIFF 栅格窗口读取结果无效');
  }

  return rasters as SupportedRasterArray[];
}

function buildDefaultExportFilename(sourceName: string): string {
  return sourceName.replace(/(\.tiff?)?$/i, '-clipped.tif');
}

function buildWindowOrigin(
  window: [number, number, number, number],
  origin: RasterOrigin,
  resolution: RasterResolution,
): RasterOrigin {
  const [startCol, startRow] = window;
  const [originX, originY, originZ = 0] = origin;
  const [resolutionX, resolutionY] = resolution;

  return [originX + startCol * resolutionX, originY + startRow * resolutionY, originZ];
}

function toBlobPart(buffer: ArrayBuffer | ArrayBufferView): ArrayBuffer | Uint8Array {
  if (buffer instanceof ArrayBuffer) {
    return buffer;
  }

  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

export async function exportFenceGeoTiff(input: {
  file: File;
  fence: FenceFeature;
  filename?: string;
}): Promise<{ blob: Blob; filename: string }> {
  const { file, fence, filename } = input;
  const arrayBuffer = await readBlobBuffer(file);
  const tiff = await fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();
  const origin = image.getOrigin() as RasterOrigin;
  const resolution = image.getResolution() as RasterResolution;
  const window = getPixelWindowFromFenceBoundingBox({
    bbox: fence.summary.bbox,
    rasterWidth: image.getWidth(),
    rasterHeight: image.getHeight(),
    origin,
    resolution,
  });
  const bands = normalizeRasterBands(
    await image.readRasters({
      window,
      interleave: false,
    }),
  );
  const bitsPerSample = Array.from({ length: image.getSamplesPerPixel() }, (_, index) =>
    image.getBitsPerSample(index),
  );
  const sampleFormat = Array.from({ length: image.getSamplesPerPixel() }, (_, index) =>
    image.getSampleFormat(index),
  );
  const noDataValue = pickExportNoDataValue({
    sourceNoDataValue: image.getGDALNoData(),
    sampleFormat,
    bitsPerSample,
    bands,
  });
  const clippedWidth = window[2] - window[0];
  const clippedHeight = window[3] - window[1];
  const maskedBands = applyFenceNoDataMask({
    bands,
    window,
    width: clippedWidth,
    height: clippedHeight,
    origin,
    resolution,
    fenceRings: fence.geometry.coordinates,
    noDataValue,
  });
  const metadata = buildGeoTiffExportMetadata({
    width: clippedWidth,
    height: clippedHeight,
    origin: buildWindowOrigin(window, origin, resolution),
    resolution,
    bitsPerSample,
    sampleFormat,
    samplesPerPixel: image.getSamplesPerPixel(),
    geoKeys: image.getGeoKeys(),
    noDataValue,
    photometricInterpretation: image.getFileDirectory().PhotometricInterpretation,
  });
  const encoded = writeArrayBuffer(maskedBands, metadata);

  return {
    blob: new Blob([toBlobPart(encoded)], { type: 'image/tiff' }),
    filename: filename ?? buildDefaultExportFilename(file.name),
  };
}

export async function downloadExportedGeoTiff(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob);

  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
