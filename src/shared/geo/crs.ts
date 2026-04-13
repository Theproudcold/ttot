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

export function isLikelyProjectedCrs(crsCode: string): boolean {
  return !GEOGRAPHIC_CRS.has(crsCode.toUpperCase());
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
