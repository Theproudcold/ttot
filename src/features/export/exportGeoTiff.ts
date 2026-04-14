import {
  applyGridAggregationToFenceWindowBands,
  pickExportNoDataValue,
  readGeoTiffFenceWindow,
  type SupportedRasterArray,
} from '@/shared/geo/geotiffExport';
import { writeGeoTiffBuffer } from '@/shared/geo/geotiffWriter';
import type { MetricTransform } from '@/shared/geo/crs';
import type { FenceFeature } from '@/shared/types/fence';
import type {
  RasterClassificationLayer,
  RasterRuleClassificationLayer,
  RasterOrigin,
  RasterResolution,
} from '@/shared/types/raster';

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

function isNumericArrayLike(value: unknown): value is number[] | Uint16Array | Float64Array {
  return Array.isArray(value) || ArrayBuffer.isView(value);
}

export async function exportFenceGeoTiff(input: {
  file: File;
  fence: FenceFeature;
  gridCellSize: number;
  filename?: string;
  activeClassificationLayer?: RasterClassificationLayer | null;
  metricTransform?: MetricTransform | null;
}): Promise<{ blob: Blob; filename: string }> {
  const { file, fence, gridCellSize, filename, activeClassificationLayer, metricTransform } = input;
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
    gridCellWidth: gridCellSize,
    gridCellHeight: gridCellSize,
    sourceNoDataValue,
    noDataValue: exportNoDataValue,
    metricTransform: metricTransform ?? undefined,
  });

  let finalBands: SupportedRasterArray[] = masked.bands;
  let finalBitsPerSample = bitsPerSample;
  let finalSampleFormat = sampleFormat;
  let finalSamplesPerPixel = samplesPerPixel;

  if (activeClassificationLayer?.mode === 'rules' && finalBands[0]) {
    const rules = (activeClassificationLayer as RasterRuleClassificationLayer).rules;
    
    // 强制使用 Float32Array 以完美支持包含小数点的施药用量（即使主波段是 Int）
    const prescriptionBand = new Float32Array(finalBands[0].length);
    prescriptionBand.fill(exportNoDataValue);

    for (let i = 0; i < finalBands[0].length; i++) {
        const val = finalBands[0][i];
        if (val !== exportNoDataValue && val !== sourceNoDataValue && val != null) {
            for (const rule of rules) {
                if (val >= rule.min && (rule.max === null || val <= rule.max)) {
                    if (rule.applicationRate != null) {
                        prescriptionBand[i] = rule.applicationRate;
                    }
                    break;
                }
            }
        }
    }

    finalBands = finalBands.map(band => {
        if (band instanceof Float32Array) return band;
        const f32Band = new Float32Array(band.length);
        f32Band.set(band);
        return f32Band;
    });

    finalBands = [...finalBands, prescriptionBand];
    finalBitsPerSample = finalBands.map(() => 32);
    finalSampleFormat = finalBands.map(() => 3);
    finalSamplesPerPixel += 1;
  }

  const [croppedOriginX, croppedOriginY, croppedOriginZ = 0] = buildWindowOrigin(
    window,
    origin,
    resolution,
  );
  const encoded = writeGeoTiffBuffer({
    width: clippedWidth,
    height: clippedHeight,
    bands: finalBands,
    bitsPerSample: finalBitsPerSample,
    sampleFormat: finalSampleFormat,
    samplesPerPixel: finalSamplesPerPixel,
    photometricInterpretation:
      typeof fileDirectory.PhotometricInterpretation === 'number'
        ? fileDirectory.PhotometricInterpretation
        : undefined,
    modelPixelScale: isNumericArrayLike(fileDirectory.ModelPixelScale)
      ? (fileDirectory.ModelPixelScale as number[])
      : [Math.abs(resolution[0]), Math.abs(resolution[1]), 0],
    modelTiepoint: [0, 0, 0, croppedOriginX, croppedOriginY, croppedOriginZ],
    geoKeyDirectory: isNumericArrayLike(fileDirectory.GeoKeyDirectory)
      ? (fileDirectory.GeoKeyDirectory as Uint16Array | number[])
      : undefined,
    geoAsciiParams:
      typeof fileDirectory.GeoAsciiParams === 'string' ? fileDirectory.GeoAsciiParams : undefined,
    geoDoubleParams: isNumericArrayLike(fileDirectory.GeoDoubleParams)
      ? (fileDirectory.GeoDoubleParams as Float64Array | number[])
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
