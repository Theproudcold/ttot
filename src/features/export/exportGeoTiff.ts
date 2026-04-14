import {
  applyGridAggregationToFenceWindowBands,
  pickExportNoDataValue,
  readGeoTiffFenceWindow,
} from '@/shared/geo/geotiffExport';
import { writeGeoTiffBuffer } from '@/shared/geo/geotiffWriter';
import type { FenceFeature } from '@/shared/types/fence';
import type { RasterOrigin, RasterResolution } from '@/shared/types/raster';

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

function toBlobPart(buffer: ArrayBuffer | ArrayBufferView): BlobPart {
  if (buffer instanceof ArrayBuffer) {
    return buffer;
  }

  const copied = new Uint8Array(buffer.byteLength);
  copied.set(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
  return copied;
}

export async function exportFenceGeoTiff(input: {
  file: File;
  fence: FenceFeature;
  gridCellSize: number;
  filename?: string;
}): Promise<{ blob: Blob; filename: string }> {
  const { file, fence, gridCellSize, filename } = input;
  const fenceWindow = await readGeoTiffFenceWindow({
    file,
    fenceRings: fence.geometry.coordinates,
  });
  const {
    bands,
    window,
    width: clippedWidth,
    height: clippedHeight,
    origin,
    resolution,
    sourceNoDataValue,
    bitsPerSample,
    sampleFormat,
    samplesPerPixel,
    fileDirectory,
  } = fenceWindow;
  const exportNoDataValue = pickExportNoDataValue({
    sourceNoDataValue,
    sampleFormat,
    bitsPerSample,
    bands,
  });
  const masked = applyGridAggregationToFenceWindowBands({
    bands,
    window,
    width: clippedWidth,
    height: clippedHeight,
    origin,
    resolution,
    fenceRings: fence.geometry.coordinates,
    gridCellSize,
    sourceNoDataValue,
    noDataValue: exportNoDataValue,
  });
  const [croppedOriginX, croppedOriginY, croppedOriginZ = 0] = buildWindowOrigin(
    window,
    origin,
    resolution,
  );
  const encoded = writeGeoTiffBuffer({
    width: clippedWidth,
    height: clippedHeight,
    bands: masked.bands,
    bitsPerSample,
    sampleFormat,
    samplesPerPixel,
    photometricInterpretation:
      typeof fileDirectory.PhotometricInterpretation === 'number'
        ? fileDirectory.PhotometricInterpretation
        : undefined,
    modelPixelScale: Array.isArray(fileDirectory.ModelPixelScale)
      ? (fileDirectory.ModelPixelScale as number[])
      : [Math.abs(resolution[0]), Math.abs(resolution[1]), 0],
    modelTiepoint: [0, 0, 0, croppedOriginX, croppedOriginY, croppedOriginZ],
    geoKeyDirectory: Array.isArray(fileDirectory.GeoKeyDirectory)
      ? (fileDirectory.GeoKeyDirectory as number[])
      : undefined,
    geoAsciiParams:
      typeof fileDirectory.GeoAsciiParams === 'string' ? fileDirectory.GeoAsciiParams : undefined,
    geoDoubleParams: Array.isArray(fileDirectory.GeoDoubleParams)
      ? (fileDirectory.GeoDoubleParams as number[])
      : undefined,
    gdalNoData:
      (sourceNoDataValue !== null && Number.isFinite(sourceNoDataValue)) || masked.maskedPixelCount > 0
        ? String(sourceNoDataValue ?? exportNoDataValue)
        : undefined,
  });

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
