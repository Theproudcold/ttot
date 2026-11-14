import type { MetricTransform } from '@/shared/geo/crs';
import type { FenceRings } from '@/shared/types/fence';
import type { GridAggregationMode } from '@/shared/types/grid';
import type { RasterWorkerRequest } from '@/shared/types/raster';

type AggregateGridPayload = Extract<RasterWorkerRequest, { type: 'aggregate-grid' }>['payload'];

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
