import proj4 from 'proj4';
import { get as getProjection } from 'ol/proj.js';
import { register } from 'ol/proj/proj4.js';

export { createMetricTransform, isLikelyProjectedCrs } from './metricTransform';
export type { CoordinateDisplayMode, MetricTransform } from './metricTransform';

export type MetricExtent = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export function getDegreeToMeterScale(latitude: number): { scaleX: number; scaleY: number } {
  const scaleY = 111320;
  const scaleX = 111320 * Math.cos((latitude * Math.PI) / 180);
  return { scaleX, scaleY };
}

import type { RasterMetadata } from '@/shared/types/raster';

const ABSOLUTE_MIN_CELL_SIZE = 0.01;

/**
 * 根据影像元数据计算网格尺寸的最小允许值。
 * 最小值不得低于影像像元的物理尺寸（米），且绝对不低于 0.01m。
 */
export function getMinCellSizeFromMetadata(
  metadata: RasterMetadata | null | undefined,
): number {
  if (!metadata?.cellSize.x) {
    return ABSOLUTE_MIN_CELL_SIZE;
  }

  const { x, unit } = metadata.cellSize;

  if (unit === 'degree') {
    const latitude = (metadata.boundingBox[1] + metadata.boundingBox[3]) / 2;
    const { scaleX } = getDegreeToMeterScale(latitude);
    return Math.max(x * scaleX, ABSOLUTE_MIN_CELL_SIZE);
  }

  return Math.max(x, ABSOLUTE_MIN_CELL_SIZE);
}

export type GridEstimate = {
  rows: number;
  cols: number;
  total: number;
};

const CUSTOM_PROJ4_DEFS: Record<string, string> = {
  'EPSG:4549':
    '+proj=tmerc +lat_0=0 +lon_0=120 +k=1 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs +type=crs',
};

export function ensureProjectionRegistered(crsCode: string): void {
  if (!crsCode || crsCode === 'UNKNOWN' || getProjection(crsCode)) {
    return;
  }

  const definition = CUSTOM_PROJ4_DEFS[crsCode.toUpperCase()];
  if (!definition) {
    return;
  }

  proj4.defs(crsCode, definition);
  register(proj4);
}

export function estimateGridCount(extent: MetricExtent, cellSize: number): GridEstimate {
  if (cellSize <= 0) {
    throw new Error('cell size must be greater than 0');
  }

  const width = Math.max(0, extent.maxX - extent.minX);
  const height = Math.max(0, extent.maxY - extent.minY);
  const cols = Math.ceil(width / cellSize);
  const rows = Math.ceil(height / cellSize);

  return {
    rows,
    cols,
    total: rows * cols,
  };
}
