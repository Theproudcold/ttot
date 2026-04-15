import type {
  FenceBoundingBox,
  FenceFeature,
  FencePosition,
  FenceRings,
  FenceSummary,
} from '@/shared/types/fence';
import type { RasterValidityMask } from '@/shared/types/raster';

/**
 * 使用鞋带公式（Shoelace）计算单个环的有向面积。
 */
function getRingArea(ring: FenceRings[number]): number {
  let area = 0;

  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[index + 1];
    area += x1 * y2 - x2 * y1;
  }

  return area / 2;
}

/**
 * 计算多边形所有环的边界框 [minX, minY, maxX, maxY]。
 */
function getBoundingBox(rings: FenceRings): FenceBoundingBox {
  const allPoints = rings.flat();
  const xs = allPoints.map(([x]) => x);
  const ys = allPoints.map(([, y]) => y);

  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * 射线法（Ray Casting）判断点是否落在单个环内。
 */
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

/**
 * 将索引值限制在 [0, max] 范围内。
 */
function clampIndex(value: number, max: number): number {
  return Math.min(Math.max(0, value), max);
}

/**
 * 将地理坐标转换为有效性掩码（validity mask）中的线性索引。
 */
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

/**
 * 对线段进行等距采样，返回采样点列表（包含起点和终点）。
 */
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

/**
 * 计算围栏摘要信息：面积、边界框和顶点数。
 */
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

/**
 * 根据坐标环构建标准围栏要素对象。
 */
export function buildFenceFeature(rings: FenceRings): FenceFeature {
  return {
    geometry: {
      type: 'Polygon',
      coordinates: rings,
    },
    summary: getFenceSummary(rings),
  };
}

/**
 * 判断点是否位于围栏内部（支持外环与洞环）。
 */
export function isPointInFence(point: FencePosition, rings: FenceRings): boolean {
  const [outerRing, ...holes] = rings;
  if (!outerRing || !isPointInRing(point, outerRing)) {
    return false;
  }

  return !holes.some((hole) => isPointInRing(point, hole));
}

/**
 * 判断坐标是否落在影像有效数据掩码范围内。
 */
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

/**
 * Sutherland–Hodgman 多边形裁剪：将单个环裁剪到矩形边界框内。
 */
function clipRingToBoundingBox(
  ring: FenceRings[number],
  bbox: FenceBoundingBox,
): FenceRings[number] {
  const [minX, minY, maxX, maxY] = bbox;

  function inside(p: FencePosition, edge: number): boolean {
    switch (edge) {
      case 0:
        return p[0] >= minX;
      case 1:
        return p[0] <= maxX;
      case 2:
        return p[1] >= minY;
      case 3:
        return p[1] <= maxY;
      default:
        return false;
    }
  }

  function intersection(s: FencePosition, e: FencePosition, edge: number): FencePosition {
    const dx = e[0] - s[0];
    const dy = e[1] - s[1];
    switch (edge) {
      case 0: {
        const t = (minX - s[0]) / (dx || Number.EPSILON);
        return [minX, s[1] + dy * t];
      }
      case 1: {
        const t = (maxX - s[0]) / (dx || Number.EPSILON);
        return [maxX, s[1] + dy * t];
      }
      case 2: {
        const t = (minY - s[1]) / (dy || Number.EPSILON);
        return [s[0] + dx * t, minY];
      }
      case 3: {
        const t = (maxY - s[1]) / (dy || Number.EPSILON);
        return [s[0] + dx * t, maxY];
      }
      default:
        return s;
    }
  }

  let output = [...ring];
  for (let edge = 0; edge < 4; edge += 1) {
    const input = output;
    output = [];
    if (input.length === 0) break;
    let s = input[input.length - 1];
    for (const e of input) {
      if (inside(e, edge)) {
        if (!inside(s, edge)) {
          output.push(intersection(s, e, edge));
        }
        output.push(e);
      } else if (inside(s, edge)) {
        output.push(intersection(s, e, edge));
      }
      s = e;
    }
  }

  const deduped: FenceRings[number] = [];
  for (const p of output) {
    const last = deduped[deduped.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) {
      deduped.push(p);
    }
  }
  if (deduped.length > 1) {
    const first = deduped[0];
    const last = deduped[deduped.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      deduped.push([...first]);
    }
  }

  return deduped;
}

/**
 * 将围栏的所有环裁剪到指定边界框内。
 */
export function clipFenceToBoundingBox(rings: FenceRings, bbox: FenceBoundingBox): FenceRings {
  return rings.map((ring) => clipRingToBoundingBox(ring, bbox));
}

/**
 * 判断整个围栏是否完全落在影像有效数据掩码内。
 * 采用边采样 + 内部像素中心点双重检查。
 */
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

/**
 * 追踪围栏与有效数据掩码交集区域的有效像素外轮廓。
 * 基于栅格单元邻接边提取，返回简化前的原始轮廓环。
 */
function traceValidPixelOutline(
  rings: FenceRings,
  validityMask: RasterValidityMask,
): FenceRings[number] {
  const [minX, minY, maxX, maxY] = validityMask.boundingBox;
  const cellWidth = (maxX - minX) / validityMask.width;
  const cellHeight = (maxY - minY) / validityMask.height;
  const { bbox } = getFenceSummary(rings);
  const [fenceMinX, fenceMinY, fenceMaxX, fenceMaxY] = bbox;

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

  const validKey = (r: number, c: number) => `${r},${c}`;
  const validSet = new Set<string>();
  const validCenters: FencePosition[] = [];

  for (let row = startRow; row <= endRow; row += 1) {
    for (let col = startCol; col <= endCol; col += 1) {
      if (validityMask.data[row * validityMask.width + col] === 1) {
        const centerX = minX + (col + 0.5) * cellWidth;
        const centerY = maxY - (row + 0.5) * cellHeight;
        if (isPointInFence([centerX, centerY], rings)) {
          validSet.add(validKey(row, col));
          validCenters.push([centerX, centerY]);
        }
      }
    }
  }

  if (validSet.size === 0) {
    return [];
  }

  type Edge = { sx: number; sy: number; ex: number; ey: number };
  const edges: Edge[] = [];

  for (let row = startRow; row <= endRow; row += 1) {
    for (let col = startCol; col <= endCol; col += 1) {
      if (!validSet.has(validKey(row, col))) continue;

      if (!validSet.has(validKey(row, col - 1))) {
        edges.push({ sx: col, sy: row + 1, ex: col, ey: row });
      }
      if (!validSet.has(validKey(row, col + 1))) {
        edges.push({ sx: col + 1, sy: row, ex: col + 1, ey: row + 1 });
      }
      if (!validSet.has(validKey(row - 1, col))) {
        edges.push({ sx: col, sy: row, ex: col + 1, ey: row });
      }
      if (!validSet.has(validKey(row + 1, col))) {
        edges.push({ sx: col + 1, sy: row + 1, ex: col, ey: row + 1 });
      }
    }
  }

  if (edges.length === 0) {
    return [];
  }

  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const key = `${e.sx},${e.sy}`;
    const nexts = adjacency.get(key) ?? [];
    nexts.push(`${e.ex},${e.ey}`);
    adjacency.set(key, nexts);
  }

  const visitedEdges = new Set<string>();
  const result: FencePosition[] = [];

  const startKey = Array.from(adjacency.keys())[0];
  if (!startKey) return [];

  let current = startKey;
  while (true) {
    const [cx, cy] = current.split(',').map(Number) as [number, number];
    result.push([minX + cx * cellWidth, maxY - cy * cellHeight]);

    const nexts = adjacency.get(current) ?? [];
    let next: string | null = null;
    for (const n of nexts) {
      const edgeKey = `${current}->${n}`;
      if (!visitedEdges.has(edgeKey)) {
        next = n;
        visitedEdges.add(edgeKey);
        break;
      }
    }
    if (!next || next === startKey) break;
    current = next;
  }

  if (
    result.length > 1 &&
    (result[result.length - 1][0] !== result[0][0] || result[result.length - 1][1] !== result[0][1])
  ) {
    result.push([...result[0]]);
  }

  if (result.length >= 4 && validCenters.length > 0) {
    const centroidX = validCenters.reduce((s, [x]) => s + x, 0) / validCenters.length;
    const centroidY = validCenters.reduce((s, [, y]) => s + y, 0) / validCenters.length;
    const epsilon = 1e-7;
    for (let i = 0; i < result.length; i++) {
      const [x, y] = result[i];
      result[i] = [x + (centroidX - x) * epsilon, y + (centroidY - y) * epsilon];
    }
  }

  return result;
}

/**
 * 计算点到线段的垂直距离。
 */
function perpendicularDistance(
  point: FencePosition,
  lineStart: FencePosition,
  lineEnd: FencePosition,
): number {
  const dx = lineEnd[0] - lineStart[0];
  const dy = lineEnd[1] - lineStart[1];
  const mag = Math.hypot(dx, dy);
  if (mag === 0) {
    return Math.hypot(point[0] - lineStart[0], point[1] - lineStart[1]);
  }
  const u = ((point[0] - lineStart[0]) * dx + (point[1] - lineStart[1]) * dy) / (mag * mag);
  const clampedU = Math.max(0, Math.min(1, u));
  const projX = lineStart[0] + clampedU * dx;
  const projY = lineStart[1] + clampedU * dy;
  return Math.hypot(point[0] - projX, point[1] - projY);
}

/**
 * Douglas–Peucker 算法：递归地简化多边形环，保留偏离最大的顶点。
 */
function douglasPeucker(ring: FenceRings[number], tolerance: number): FenceRings[number] {
  if (ring.length <= 3) {
    return ring;
  }

  let maxDist = 0;
  let index = 0;

  for (let i = 1; i < ring.length - 1; i++) {
    const dist = perpendicularDistance(ring[i], ring[0], ring[ring.length - 1]);
    if (dist > maxDist) {
      maxDist = dist;
      index = i;
    }
  }

  if (maxDist > tolerance) {
    const left = douglasPeucker(ring.slice(0, index + 1), tolerance);
    const right = douglasPeucker(ring.slice(index), tolerance);
    return [...left.slice(0, -1), ...right];
  }

  return [ring[0], ring[ring.length - 1]];
}

/**
 * 简化多边形环，并确保首尾闭合。
 */
function simplifyRing(ring: FenceRings[number], tolerance: number): FenceRings[number] {
  const simplified = douglasPeucker(ring, tolerance);
  if (simplified.length >= 3) {
    const first = simplified[0];
    const last = simplified[simplified.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      simplified.push([...first]);
    }
  }
  return simplified;
}

/**
 * 将围栏裁剪到有效性掩码范围内。
 * 先提取有效像素轮廓，再用 Douglas–Peucker 简化。
 */
export function clipFenceToValidityMask(rings: FenceRings, validityMask: RasterValidityMask): FenceRings {
  const outline = traceValidPixelOutline(rings, validityMask);
  if (outline.length < 4) {
    return [[]];
  }

  const [minX, minY, maxX, maxY] = validityMask.boundingBox;
  const cellWidth = (maxX - minX) / validityMask.width;
  const cellHeight = (maxY - minY) / validityMask.height;
  const tolerance = Math.max(cellWidth, cellHeight) * 1.5;
  const simplified = simplifyRing(outline, tolerance);

  if (simplified.length < 4) {
    return [outline];
  }

  return [simplified];
}
