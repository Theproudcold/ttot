import {
  applyGridAggregationToFenceWindowBands,
  collectAggregationOutputValues,
  pickExportNoDataValue,
  readGeoTiffFenceWindow,
  type SupportedRasterArray,
} from '@/shared/geo/geotiffExport';
import { writeGeoTiffBuffer } from '@/shared/geo/geotiffWriter';
import { countExtraSamples } from '@/shared/geo/rasterPreview';
import { resolveCellAmount } from '@/shared/geo/applicationRate';
import { encodeEmbeddedSnapshot, type ProjectSnapshotV1 } from '@/features/project/projectSnapshot';
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

/** 内嵌配方的长度上限：超过则放弃内嵌，避免把 ASCII tag 撑得过大 */
export const EMBEDDED_SNAPSHOT_MAX_LENGTH = 32_768;

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

/**
 * 将任意栅格波段转为 Float32Array。
 * 用于把"聚合均值"这类可能含小数的结果从整数位深中解放出来。
 */
function toFloat32Band(band: SupportedRasterArray): Float32Array {
  if (band instanceof Float32Array) {
    return band;
  }

  const nextBand = new Float32Array(band.length);
  nextBand.set(band);
  return nextBand;
}

import type { GridAggregationMode } from '@/shared/types/grid';

export async function exportFenceGeoTiff(input: {
  file: File;
  fence: FenceFeature;
  gridCellSize: number;
  aggregationMode?: GridAggregationMode;
  filename?: string;
  activeClassificationLayer?: RasterClassificationLayer | null;
  metricTransform?: MetricTransform | null;
  rotationDeg?: number;
  /**
   * 需要内嵌进导出文件的工程配方。
   * 提供后写入 ImageDescription（tag 270），使该文件被重新导入时可还原设置。
   */
  projectSnapshot?: ProjectSnapshotV1 | null;
}): Promise<{ blob: Blob; filename: string; warnings: string[] }> {
  const { file, fence, gridCellSize, aggregationMode, filename, activeClassificationLayer, metricTransform, rotationDeg, projectSnapshot } = input;
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
    fileDirectory,
  } = fenceWindow;
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
    // 聚合值已知后再定哨兵：输出波段已统一为 Float32，因此按 Float32 取值域挑选，
    // 并避开所有真实的聚合值，防止某个网格被下游当成 NoData。
    resolveNoDataValue: (aggregation) =>
      pickExportNoDataValue({
        sourceNoDataValue,
        sampleFormat: [3],
        bitsPerSample: [32],
        bands,
        reservedValues: collectAggregationOutputValues(aggregation),
      }),
    metricTransform: metricTransform ?? undefined,
    aggregationMode,
    rotationDeg,
  });
  const exportNoDataValue = masked.noDataValue;

  // 聚合产物是像元均值，可能包含小数，而源影像的整数位深无法表示这些值。
  // 若沿用源的 BitsPerSample/SampleFormat，writer 会按整数写入造成截断（有符号还会取模）。
  // 因此无论是否启用分类规则，导出波段一律提升为 Float32。
  let finalBands: SupportedRasterArray[] = masked.bands.map(toFloat32Band);
  // 源文件自带的附加波段（如 alpha）必须继续声明，否则读取端会把它当成数据波段
  let extraSamplesCount = countExtraSamples(fileDirectory);

  if (activeClassificationLayer?.mode === 'rules' && finalBands[0]) {
    const rules = (activeClassificationLayer as RasterRuleClassificationLayer).rules;
    
    // 处方波段同样使用 Float32Array，以支持包含小数点的施药用量
    const prescriptionBand = new Float32Array(finalBands[0].length);
    prescriptionBand.fill(exportNoDataValue);

    // 网格为正方形，单元格面积由网格尺寸得出；每格的用量按规则预先换算一次即可
    const cellAreaM2 = gridCellSize > 0 ? gridCellSize * gridCellSize : 0;
    const ruleCellAmounts = rules.map((rule) => resolveCellAmount(rule, cellAreaM2));

    for (let i = 0; i < finalBands[0].length; i++) {
        const val = finalBands[0][i];
        if (val !== exportNoDataValue) {
            for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex += 1) {
                const rule = rules[ruleIndex];
                if (val >= rule.min && (rule.max === null || val <= rule.max)) {
                    const amount = ruleCellAmounts[ruleIndex];
                    if (amount !== null) {
                        prescriptionBand[i] = amount;
                    }
                    break;
                }
            }
        }
    }

    finalBands = [...finalBands, prescriptionBand];
    // 处方波段是显式声明的附加波段；不做声明会让重新导入时把它算成数据波段
    extraSamplesCount += 1;
  }

  const finalBitsPerSample = finalBands.map(() => 32);
  const finalSampleFormat = finalBands.map(() => 3);

  const [croppedOriginX, croppedOriginY, croppedOriginZ = 0] = buildWindowOrigin(
    window,
    origin,
    resolution,
  );
  const embeddedWarnings: string[] = [];
  let imageDescription: string | undefined;

  if (projectSnapshot) {
    const encodedSnapshot = encodeEmbeddedSnapshot(projectSnapshot);

    if (encodedSnapshot.length <= EMBEDDED_SNAPSHOT_MAX_LENGTH) {
      imageDescription = encodedSnapshot;
    } else {
      embeddedWarnings.push(
        `设置过大（约 ${Math.ceil(encodedSnapshot.length / 1024)}KB），已跳过内嵌，请另存工程文件。`,
      );
    }
  }

  const encoded = writeGeoTiffBuffer({
    width: clippedWidth,
    height: clippedHeight,
    bands: finalBands,
    bitsPerSample: finalBitsPerSample,
    sampleFormat: finalSampleFormat,
    samplesPerPixel: finalBands.length,
    photometricInterpretation:
      typeof fileDirectory.PhotometricInterpretation === 'number'
        ? fileDirectory.PhotometricInterpretation
        : undefined,
    extraSamplesCount,
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
        ? String(exportNoDataValue)
        : undefined,
    imageDescription,
  });

  return {
    blob: new Blob([toBlobPart(encoded)], { type: 'image/tiff' }),
    filename: filename ?? buildDefaultExportFilename(file.name),
    warnings: embeddedWarnings,
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
