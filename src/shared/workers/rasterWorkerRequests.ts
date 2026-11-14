import { createMetricTransformFromDescriptor } from '@/shared/geo/crs';
import type { MetricTransform } from '@/shared/geo/crs';
import type { ProjectSnapshotV1 } from '@/features/project/projectSnapshot';
import type { FenceRings } from '@/shared/types/fence';
import type { GridAggregationMode } from '@/shared/types/grid';
import type {
  RasterClassificationLayer,
  RasterMetadata,
  RasterMetadataPayload,
  RasterWorkerRequest,
} from '@/shared/types/raster';

type AggregateGridPayload = Extract<RasterWorkerRequest, { type: 'aggregate-grid' }>['payload'];
type ExportGeoTiffPayload = Extract<RasterWorkerRequest, { type: 'export-geotiff' }>['payload'];

/**
 * 构建网格聚合的 Worker 载荷。
 *
 * 单独抽出来是为了让「载荷必须可结构化克隆」这件事可被测试覆盖：
 * 曾经这里直接塞 `metricTransform`，而它带有 `toMetric` / `fromMetric` 函数，
 * postMessage 必然抛 DataCloneError，于是 Worker 路径每次都被 catch 吞掉、
 * 静默回退主线程（表面功能正常，实际从未在 Worker 里跑过）。
 */
export function buildAggregateGridPayload(input: {
  source: File | string;
  sourceKey?: string;
  fenceRings: FenceRings;
  metricTransform: MetricTransform | null | undefined;
  gridCellWidth: number;
  gridCellHeight: number;
  aggregationMode: GridAggregationMode;
  rotationDeg: number;
  samples?: number[];
}): AggregateGridPayload {
  return {
    source: input.source,
    sourceKey: input.sourceKey,
    fenceRings: input.fenceRings,
    samples: input.samples ?? [0],
    metricTransformDescriptor: input.metricTransform?.descriptor ?? null,
    gridCellWidth: input.gridCellWidth,
    gridCellHeight: input.gridCellHeight,
    aggregationMode: input.aggregationMode,
    rotationDeg: input.rotationDeg,
  };
}

/**
 * 构建处方 GeoTIFF 导出的 Worker 载荷。
 * 同样只传可克隆数据（度量变换走 descriptor，配方快照本身是纯数据）。
 */
export function buildExportGeoTiffPayload(input: {
  file: File;
  fenceRings: FenceRings;
  gridCellSize: number;
  aggregationMode?: GridAggregationMode;
  filename?: string;
  activeClassificationLayer?: RasterClassificationLayer | null;
  metricTransform?: MetricTransform | null;
  rotationDeg?: number;
  projectSnapshot?: ProjectSnapshotV1 | null;
}): ExportGeoTiffPayload {
  return {
    source: input.file,
    fenceRings: input.fenceRings,
    gridCellSize: input.gridCellSize,
    aggregationMode: input.aggregationMode,
    filename: input.filename,
    activeClassificationLayer: input.activeClassificationLayer ?? null,
    metricTransformDescriptor: input.metricTransform?.descriptor ?? null,
    rotationDeg: input.rotationDeg,
    projectSnapshot: input.projectSnapshot ?? null,
  };
}

/**
 * 把 Worker 返回的可克隆元信息还原成主线程使用的 RasterMetadata。
 * 度量变换按描述重建，与 Worker 内使用的那份逐位一致。
 */
export function rebuildRasterMetadata(payload: RasterMetadataPayload): RasterMetadata {
  const { metricTransformDescriptor, ...rest } = payload;

  return {
    ...rest,
    metricTransform: createMetricTransformFromDescriptor(metricTransformDescriptor),
  };
}
