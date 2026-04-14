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
