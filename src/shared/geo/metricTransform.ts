const EARTH_RADIUS_METERS = 6378137;
const GEOGRAPHIC_CRS = new Set(['EPSG:4326', 'CRS:84']);

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
  return !GEOGRAPHIC_CRS.has(crsCode.toUpperCase());
}

export function createMetricTransform(input: {
  crsCode: string;
  boundingBox: [number, number, number, number];
}): MetricTransform {
  const { crsCode, boundingBox } = input;
  const [minX, minY, maxX, maxY] = boundingBox;

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

  const toMetric = ([lon, lat]: [number, number]): [number, number] => {
    const deltaLonRadians = toRadians(lon - centerLon);
    const deltaLatRadians = toRadians(lat - centerLat);

    return [
      EARTH_RADIUS_METERS * deltaLonRadians * Math.cos(centerLatRadians),
      EARTH_RADIUS_METERS * deltaLatRadians,
    ];
  };

  const fromMetric = ([x, y]: [number, number]): [number, number] => [
    centerLon + toDegrees(x / (EARTH_RADIUS_METERS * Math.cos(centerLatRadians))),
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
