import proj4 from 'proj4';
import { get as getProjection } from 'ol/proj.js';
import { register } from 'ol/proj/proj4.js';

export type MetricExtent = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export type GridEstimate = {
  rows: number;
  cols: number;
  total: number;
};

const GEOGRAPHIC_CRS = new Set(['EPSG:4326', 'CRS:84']);
const CUSTOM_PROJ4_DEFS: Record<string, string> = {
  'EPSG:4549':
    '+proj=tmerc +lat_0=0 +lon_0=120 +k=1 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs +type=crs',
};

export function isLikelyProjectedCrs(crsCode: string): boolean {
  return !GEOGRAPHIC_CRS.has(crsCode.toUpperCase());
}

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
