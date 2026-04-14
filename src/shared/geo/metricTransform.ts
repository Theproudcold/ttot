const EARTH_RADIUS_METERS = 6378137;
const MIN_COSINE_MAGNITUDE = 1e-6;
const GEOGRAPHIC_CRS = new Set(['EPSG:4326', 'EPSG:4490', 'EPSG:4269', 'CRS:84', 'OGC:CRS84']);
const PROJECTED_EPSG_OVERRIDES = new Set([3857, 4549]);

export type CoordinateDisplayMode = 'projected' | 'geographic';

export type MetricTransform = {
  coordinateDisplayMode: CoordinateDisplayMode;
  metricExtent: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
  metricWidth: number;
  metricHeight: number;
  toMetric: (point: [number, number]) => [number, number];
  fromMetric: (point: [number, number]) => [number, number];
};

export function isLikelyProjectedCrs(crsCode: string): boolean {
  const normalizedCrsCode = normalizeCrsCode(crsCode);

  if (GEOGRAPHIC_CRS.has(normalizedCrsCode)) {
    return false;
  }

  const epsgCode = parseEpsgCode(normalizedCrsCode);
  if (epsgCode === null) {
    return true;
  }

  if (PROJECTED_EPSG_OVERRIDES.has(epsgCode)) {
    return true;
  }

  if (epsgCode >= 4000 && epsgCode < 5000) {
    return false;
  }

  return true;
}

export function createMetricTransform(input: {
  crsCode: string;
  boundingBox: [number, number, number, number];
}): MetricTransform {
  const { crsCode, boundingBox } = input;
  const [minX, minY, maxX, maxY] = boundingBox;
  validateBoundingBox(boundingBox);

  if (isLikelyProjectedCrs(crsCode)) {
    return {
      coordinateDisplayMode: 'projected',
      metricExtent: {
        minX,
        minY,
        maxX,
        maxY,
      },
      metricWidth: Math.max(0, maxX - minX),
      metricHeight: Math.max(0, maxY - minY),
      toMetric: (point) => point,
      fromMetric: (point) => point,
    };
  }

  const centerLon = (minX + maxX) / 2;
  const centerLat = (minY + maxY) / 2;
  const centerLatRadians = toRadians(centerLat);
  const longitudeScale = Math.cos(centerLatRadians);

  if (Math.abs(longitudeScale) < MIN_COSINE_MAGNITUDE) {
    throw new Error('geographic metric transform is unstable near the poles');
  }

  const toMetric = ([lon, lat]: [number, number]): [number, number] => {
    const deltaLonRadians = toRadians(lon - centerLon);
    const deltaLatRadians = toRadians(lat - centerLat);

    return [EARTH_RADIUS_METERS * deltaLonRadians * longitudeScale, EARTH_RADIUS_METERS * deltaLatRadians];
  };

  const fromMetric = ([x, y]: [number, number]): [number, number] => [
    centerLon + toDegrees(x / (EARTH_RADIUS_METERS * longitudeScale)),
    centerLat + toDegrees(y / EARTH_RADIUS_METERS),
  ];

  const metricCorners = [
    toMetric([minX, minY]),
    toMetric([minX, maxY]),
    toMetric([maxX, minY]),
    toMetric([maxX, maxY]),
  ];

  const metricExtent = {
    minX: Math.min(...metricCorners.map(([x]) => x)),
    minY: Math.min(...metricCorners.map(([, y]) => y)),
    maxX: Math.max(...metricCorners.map(([x]) => x)),
    maxY: Math.max(...metricCorners.map(([, y]) => y)),
  };

  return {
    coordinateDisplayMode: 'geographic',
    metricExtent,
    metricWidth: Math.max(0, metricExtent.maxX - metricExtent.minX),
    metricHeight: Math.max(0, metricExtent.maxY - metricExtent.minY),
    toMetric,
    fromMetric,
  };
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function toDegrees(value: number): number {
  return (value * 180) / Math.PI;
}

function normalizeCrsCode(crsCode: string): string {
  return crsCode.trim().toUpperCase();
}

function parseEpsgCode(crsCode: string): number | null {
  if (!crsCode.startsWith('EPSG:')) {
    return null;
  }

  const code = Number.parseInt(crsCode.slice(5), 10);
  return Number.isFinite(code) ? code : null;
}

function validateBoundingBox(boundingBox: [number, number, number, number]): void {
  if (!boundingBox.every(Number.isFinite)) {
    throw new Error('bounding box must contain only finite numbers');
  }

  const [minX, minY, maxX, maxY] = boundingBox;
  if (minX > maxX || minY > maxY) {
    throw new Error('bounding box must be ordered as [minX, minY, maxX, maxY]');
  }
}
