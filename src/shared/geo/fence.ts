import type {
  FenceBoundingBox,
  FenceFeature,
  FencePosition,
  FenceRings,
  FenceSummary,
} from '@/shared/types/fence';
import type { RasterValidityMask } from '@/shared/types/raster';

function getRingArea(ring: FenceRings[number]): number {
  let area = 0;

  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[index + 1];
    area += x1 * y2 - x2 * y1;
  }

  return area / 2;
}

function getBoundingBox(rings: FenceRings): FenceBoundingBox {
  const allPoints = rings.flat();
  const xs = allPoints.map(([x]) => x);
  const ys = allPoints.map(([, y]) => y);

  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function isPointInRing(point: FencePosition, ring: FenceRings[number]): boolean {
  const [x, y] = point;
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];

    const intersects =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function clampIndex(value: number, max: number): number {
  return Math.min(Math.max(0, value), max);
}

function getMaskIndex(point: FencePosition, validityMask: RasterValidityMask): number | null {
  const [x, y] = point;
  const [minX, minY, maxX, maxY] = validityMask.boundingBox;

  if (x < minX || x > maxX || y < minY || y > maxY) {
    return null;
  }

  const width = maxX - minX;
  const height = maxY - minY;
  if (width <= 0 || height <= 0) {
    return null;
  }

  const col = clampIndex(Math.floor(((x - minX) / width) * validityMask.width), validityMask.width - 1);
  const row = clampIndex(
    Math.floor(((maxY - y) / height) * validityMask.height),
    validityMask.height - 1,
  );

  return row * validityMask.width + col;
}

function sampleSegment(
  start: FencePosition,
  end: FencePosition,
  maxStep: number,
): FencePosition[] {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const distance = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(distance / maxStep));
  const points: FencePosition[] = [];

  for (let index = 0; index <= steps; index += 1) {
    const ratio = index / steps;
    points.push([start[0] + dx * ratio, start[1] + dy * ratio]);
  }

  return points;
}

export function getFenceSummary(rings: FenceRings): FenceSummary {
  const outerRing = rings[0] ?? [];
  const area = Math.abs(getRingArea(outerRing));
  const bbox = getBoundingBox(rings);
  const vertexCount = Math.max(0, outerRing.length - 1);

  return {
    area,
    bbox,
    vertexCount,
  };
}

export function buildFenceFeature(rings: FenceRings): FenceFeature {
  return {
    geometry: {
      type: 'Polygon',
      coordinates: rings,
    },
    summary: getFenceSummary(rings),
  };
}

export function isPointInFence(point: FencePosition, rings: FenceRings): boolean {
  const [outerRing, ...holes] = rings;
  if (!outerRing || !isPointInRing(point, outerRing)) {
    return false;
  }

  return !holes.some((hole) => isPointInRing(point, hole));
}

export function isCoordinateInValidityMask(
  point: FencePosition,
  validityMask: RasterValidityMask | null,
): boolean {
  if (!validityMask) {
    return false;
  }

  const index = getMaskIndex(point, validityMask);
  if (index === null) {
    return false;
  }

  return validityMask.data[index] === 1;
}

export function isFenceInsideValidityMask(
  rings: FenceRings,
  validityMask: RasterValidityMask | null,
): boolean {
  if (!validityMask) {
    return false;
  }

  const [minX, minY, maxX, maxY] = validityMask.boundingBox;
  const cellWidth = (maxX - minX) / validityMask.width;
  const cellHeight = (maxY - minY) / validityMask.height;
  const sampleStep = Math.max(Number.EPSILON, Math.min(cellWidth, cellHeight) / 2);
  const { bbox } = getFenceSummary(rings);
  const [fenceMinX, fenceMinY, fenceMaxX, fenceMaxY] = bbox;

  for (const ring of rings) {
    for (let index = 0; index < ring.length - 1; index += 1) {
      const start = ring[index];
      const end = ring[index + 1];
      for (const sample of sampleSegment(start, end, sampleStep)) {
        if (!isCoordinateInValidityMask(sample, validityMask)) {
          return false;
        }
      }
    }
  }

  const startCol = clampIndex(
    Math.floor(((fenceMinX - minX) / (maxX - minX || Number.EPSILON)) * validityMask.width),
    validityMask.width - 1,
  );
  const endCol = clampIndex(
    Math.floor(((fenceMaxX - minX) / (maxX - minX || Number.EPSILON)) * validityMask.width),
    validityMask.width - 1,
  );
  const startRow = clampIndex(
    Math.floor(((maxY - fenceMaxY) / (maxY - minY || Number.EPSILON)) * validityMask.height),
    validityMask.height - 1,
  );
  const endRow = clampIndex(
    Math.floor(((maxY - fenceMinY) / (maxY - minY || Number.EPSILON)) * validityMask.height),
    validityMask.height - 1,
  );

  for (let row = startRow; row <= endRow; row += 1) {
    for (let col = startCol; col <= endCol; col += 1) {
      const centerX = minX + (col + 0.5) * cellWidth;
      const centerY = maxY - (row + 0.5) * cellHeight;

      if (!isPointInFence([centerX, centerY], rings)) {
        continue;
      }

      if (validityMask.data[row * validityMask.width + col] !== 1) {
        return false;
      }
    }
  }

  return true;
}
