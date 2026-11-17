import {
  applyGridAggregationToFenceWindowBands,
  collectAggregationOutputValues,
  pickExportNoDataValue,
  readGeoTiffFenceWindow,
  type SupportedRasterArray,
} from '@/shared/geo/geotiffExport';
import { writeGeoTiffBufferAsync } from '@/shared/geo/geotiffWriter';
import { countExtraSamples } from '@/shared/geo/rasterPreview';
import { resolveCellAmount } from '@/shared/geo/applicationRate';
import { findRuleMatch } from '@/shared/geo/classificationRuleMatching';
import { encodeEmbeddedSnapshot, type ProjectSnapshotV1 } from '@/features/project/projectSnapshot';
import { debugLog } from '@/features/map/debugLogger';
import { buildExportGeoTiffPayload } from '@/shared/workers/rasterWorkerRequests';
import {
  createRasterWorkerJobId,
  getRasterWorker,
  requestRasterWorker,
} from '@/shared/workers/rasterWorkerRegistry';
import type { MetricTransform } from '@/shared/geo/crs';
import type { FenceFeature, FenceRings } from '@/shared/types/fence';
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

export type GeoTiffExportInput = {
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
};

/** 纯计算入参：只带围栏环，不依赖 FenceFeature 结构 */
export type GeoTiffExportBytesInput = Omit<GeoTiffExportInput, 'fence'> & {
  fenceRings: FenceRings;
};

export type GeoTiffExportResult = {
  bytes: ArrayBuffer;
  filename: string;
  warnings: string[];
};

/**
 * 生成 GeoTIFF 字节。不接触 DOM，因此既能在 Worker 内执行，也能作为主线程回退。
 */
export async function buildGeoTiffExportBytes(
  input: GeoTiffExportBytesInput,
): Promise<GeoTiffExportResult> {
  const { file, fenceRings, gridCellSize, aggregationMode, filename, activeClassificationLayer, metricTransform, rotationDeg, projectSnapshot } = input;
  const fenceWindow = await readGeoTiffFenceWindow({
    file,
    fenceRings,
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
    fenceRings,
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
    // 导出产物固定为 Float32（见下方 finalBands），因此直接用 Float32 生成改写波段，
    // 不再为每个波段多留一份整幅 Float64 缓冲
    outputType: 'float32',
  });
  const exportNoDataValue = masked.noDataValue;

  // 注意：这里不能清空 bands 来"提前释放"——它来自围栏窗口缓存（readGeoTiffFenceWindow），
  // 与缓存条目共用同一个数组，清空会让同一窗口的下一次聚合/导出读到空波段。
  // 缓存本身按 LRU 有上限，源波段的释放交给它即可。

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
            // 与 GeoJSON 导出、地图口径共用同一个判定实现，避免三处各写一套比较
            const match = findRuleMatch(rules, val);
            if (match) {
                const amount = ruleCellAmounts[match.index];
                if (amount !== null) {
                    prescriptionBand[i] = amount;
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

  const encoded = await writeGeoTiffBufferAsync({
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
    bytes: encoded,
    filename: filename ?? buildDefaultExportFilename(file.name),
    warnings: embeddedWarnings,
  };
}

function toExportResult(result: GeoTiffExportResult): { blob: Blob; filename: string; warnings: string[] } {
  return {
    blob: new Blob([toBlobPart(result.bytes)], { type: 'image/tiff' }),
    filename: result.filename,
    warnings: result.warnings,
  };
}

/**
 * 导出围栏内的处方 GeoTIFF。
 *
 * 计算本身在 Worker 内完成（顺带复用网格聚合已解码的窗口），
 * Worker 不可用或失败时回退到主线程执行同一份实现。
 */
export async function exportFenceGeoTiff(input: GeoTiffExportInput): Promise<{
  blob: Blob;
  filename: string;
  warnings: string[];
}> {
  const bytesInput: GeoTiffExportBytesInput = {
    file: input.file,
    fenceRings: input.fence.geometry.coordinates,
    gridCellSize: input.gridCellSize,
    aggregationMode: input.aggregationMode,
    filename: input.filename,
    activeClassificationLayer: input.activeClassificationLayer,
    metricTransform: input.metricTransform,
    rotationDeg: input.rotationDeg,
    projectSnapshot: input.projectSnapshot,
  };
  const worker = getRasterWorker();

  if (worker) {
    try {
      const response = await requestRasterWorker<'export-geotiff'>(
        worker,
        {
          id: createRasterWorkerJobId(),
          type: 'export-geotiff',
          payload: buildExportGeoTiffPayload(bytesInput),
        },
        180_000,
      );

      return toExportResult(response.result);
    } catch (error) {
      debugLog('export', 'Worker 导出失败，回退主线程', error);
    }
  }

  return toExportResult(await buildGeoTiffExportBytes(bytesInput));
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
