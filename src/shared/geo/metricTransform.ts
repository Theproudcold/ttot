const EARTH_RADIUS_METERS = 6378137;
const MAX_LOCAL_METRIC_DIMENSION_METERS = 100000;
const MIN_COSINE_MAGNITUDE = 1e-6;
const GEOGRAPHIC_CRS = new Set([
  'EPSG:4326',
  'EPSG:4490',
  'EPSG:4269',
  'CRS:84',
  'OGC:CRS84',
  'HTTP://WWW.OPENGIS.NET/DEF/CRS/OGC/1.3/CRS84',
]);

export type CoordinateDisplayMode = 'projected' | 'geographic' | 'unknown';

export type MetricExtent = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/**
 * 度量变换的可结构化克隆描述。
 *
 * 为什么需要它：`MetricTransform` 的 `toMetric` / `fromMetric` 是函数，
 * 而结构化克隆（postMessage / structuredClone）无法传递函数——
 * 直接把变换对象发进 Worker 会抛 DataCloneError。
 * 跨线程时传描述、在目标线程用 `createMetricTransformFromDescriptor` 重建，
 * 重建结果与原对象逐位一致（同一套公式、同一批输入）。
 */
export type MetricTransformDescriptor =
  | {
      kind: 'identity';
      coordinateDisplayMode: CoordinateDisplayMode;
      metricExtent: MetricExtent;
      metricWidth: number;
      metricHeight: number;
    }
  | {
      kind: 'geographic';
      coordinateDisplayMode: 'geographic';
      metricExtent: MetricExtent;
      metricWidth: number;
      metricHeight: number;
      /** 局部等距投影的中心经度 */
      centerLon: number;
      /** 局部等距投影的中心纬度 */
      centerLat: number;
    };

export type MetricTransform = {
  coordinateDisplayMode: CoordinateDisplayMode;
  metricExtent: MetricExtent;
  metricWidth: number;
  metricHeight: number;
  /** 可克隆描述，用于跨线程传递后重建 */
  descriptor: MetricTransformDescriptor;
  toMetric: (point: [number, number]) => [number, number];
  fromMetric: (point: [number, number]) => [number, number];
};

export function isLikelyProjectedCrs(crsCode: string): boolean {
  return !isKnownGeographicCrs(crsCode);
}

/**
 * 构建恒等度量变换（地理坐标与度量坐标 1:1 映射）。
 */
export function createIdentityMetricTransform(
  boundingBox: [number, number, number, number],
  coordinateDisplayMode: CoordinateDisplayMode = 'projected',
): MetricTransform {
  const [minX, minY, maxX, maxY] = boundingBox;

  return createMetricTransformFromDescriptor({
    kind: 'identity',
    coordinateDisplayMode,
    metricExtent: { minX, minY, maxX, maxY },
    metricWidth: Math.max(0, maxX - minX),
    metricHeight: Math.max(0, maxY - minY),
  });
}

/**
 * 根据描述重建度量变换。与创建端使用同一套公式，保证跨线程结果一致。
 */
export function createMetricTransformFromDescriptor(
  descriptor: MetricTransformDescriptor,
): MetricTransform {
  const { coordinateDisplayMode, metricExtent, metricWidth, metricHeight } = descriptor;

  if (descriptor.kind === 'identity') {
    return {
      coordinateDisplayMode,
      metricExtent,
      metricWidth,
      metricHeight,
      descriptor,
      toMetric: ([x, y]) => [x, y],
      fromMetric: ([x, y]) => [x, y],
    };
  }

  const { centerLon, centerLat } = descriptor;
  const longitudeScale = Math.cos(toRadians(centerLat));

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

  return {
    coordinateDisplayMode: 'geographic',
    metricExtent,
    metricWidth,
    metricHeight,
    descriptor,
    toMetric,
    fromMetric,
  };
}

export function createMetricTransform(input: {
  crsCode: string;
  boundingBox: [number, number, number, number];
}): MetricTransform {
  const { crsCode, boundingBox } = input;
  const [minX, minY, maxX, maxY] = boundingBox;
  validateBoundingBox(boundingBox);

  if (isUnknownCrsCode(crsCode)) {
    return createIdentityMetricTransform(boundingBox, 'unknown');
  }

  if (isLikelyProjectedCrs(crsCode)) {
    return createIdentityMetricTransform(boundingBox, 'projected');
  }

  validateGeographicBoundingBox(boundingBox);

  const centerLon = (minX + maxX) / 2;
  const centerLat = (minY + maxY) / 2;
  const longitudeScale = Math.cos(toRadians(centerLat));

  if (Math.abs(longitudeScale) < MIN_COSINE_MAGNITUDE) {
    throw new Error('geographic metric transform is unstable near the poles');
  }

  const toMetric = ([lon, lat]: [number, number]): [number, number] => {
    const deltaLonRadians = toRadians(lon - centerLon);
    const deltaLatRadians = toRadians(lat - centerLat);

    return [EARTH_RADIUS_METERS * deltaLonRadians * longitudeScale, EARTH_RADIUS_METERS * deltaLatRadians];
  };

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
  const metricWidth = Math.max(0, metricExtent.maxX - metricExtent.minX);
  const metricHeight = Math.max(0, metricExtent.maxY - metricExtent.minY);

  if (metricWidth > MAX_LOCAL_METRIC_DIMENSION_METERS || metricHeight > MAX_LOCAL_METRIC_DIMENSION_METERS) {
    throw new Error('geographic bounding box exceeds local metric transform limit');
  }

  return createMetricTransformFromDescriptor({
    kind: 'geographic',
    coordinateDisplayMode: 'geographic',
    metricExtent,
    metricWidth,
    metricHeight,
    centerLon,
    centerLat,
  });
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

function isUnknownCrsCode(crsCode: string): boolean {
  return normalizeCrsCode(crsCode) === 'UNKNOWN';
}

function isKnownGeographicCrs(crsCode: string): boolean {
  const normalizedCrsCode = normalizeCrsCode(crsCode);
  if (GEOGRAPHIC_CRS.has(normalizedCrsCode)) {
    return true;
  }

  const epsgCode = parseEpsgCode(normalizedCrsCode);
  return epsgCode !== null && GEOGRAPHIC_CRS.has(`EPSG:${epsgCode}`);
}

function parseEpsgCode(crsCode: string): number | null {
  const match = /^EPSG:(\d+)$/.exec(crsCode);
  if (!match) {
    return null;
  }

  return Number.parseInt(match[1], 10);
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

function validateGeographicBoundingBox([minLon, minLat, maxLon, maxLat]: [number, number, number, number]): void {
  if (minLat < -90 || maxLat > 90) {
    throw new Error('geographic bounding box latitude must be within [-90, 90]');
  }

  if (minLon < -180 || maxLon > 180) {
    throw new Error('geographic bounding box longitude must be within [-180, 180]');
  }
}
