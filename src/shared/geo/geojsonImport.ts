/**
 * GeoJSON 围栏导入。
 *
 * 现状缺口：导出有 GeoJSON，导入却只认 TIFF——用户把 `fence.geojson` 拿回来时无处可放。
 *
 * 本模块只做**纯逻辑**（解析、校验、必要时重投影），不写 store、不解析工程配方本身：
 * 顶层 `ttot:project` 成员原样交给调用方，由 `features/project` 层校验，
 * 这样 `shared/geo` 不会反向依赖 features（避免层次倒置与循环引用）。
 *
 * 三个必须区分的输入形态：
 * 1. 裸几何（`{type:'Polygon'}`）或单个 Feature —— 直接用；
 * 2. 本工具导出的 `fence.geojson`（1 个 Polygon 的 FeatureCollection）—— 直接用；
 * 3. 本工具导出的 `grid.geojson`（多个 Polygon 的 FeatureCollection）—— **不是围栏**，
 *    若带 `ttot:project` 则只还原设置、不猜几何。
 *
 * 投影约定：本工具导出的 GeoJSON 坐标位于**影像自身的 CRS**，因此默认不重投影
 * （否则把自己导出的围栏再导入会整体偏移）。只有调用方显式给出 `reproject` 时才转换。
 */

import proj4 from 'proj4';

import { ensureProjectionRegistered } from '@/shared/geo/crs';
import type { FenceRings } from '@/shared/types/fence';

/** GeoJSON 允许 foreign member，本工具用它在要素集合上挂工程配方 */
export const GEOJSON_PROJECT_MEMBER = 'ttot:project';

export type FenceGeoJsonSource = {
  geometryType: 'Polygon' | 'MultiPolygon';
  /** 输入里包含的要素数量（裸几何记 1） */
  featureCount: number;
};

export type FenceGeoJsonImportResult =
  | {
      ok: true;
      /** 可用的围栏环；无几何可用（例如网格文件）时为 null */
      rings: FenceRings | null;
      /** 顶层 `ttot:project` 的原始内容，交由上层用 validateProjectSnapshot 校验 */
      projectMember: unknown | null;
      warnings: string[];
      source: FenceGeoJsonSource | null;
    }
  | { ok: false; errors: string[] };

type Coordinate = [number, number];

type GeometryOptions = { from: string | null; to: string | null };

type RingResult = { ok: true; ring: Coordinate[] } | { ok: false; error: string };
type RingsResult = { ok: true; rings: FenceRings } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCoordinate(value: unknown): value is Coordinate {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    Number.isFinite(value[0]) &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[1])
  );
}

function samePoint(a: Coordinate, b: Coordinate): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** 鞋带公式，用于在 MultiPolygon 中挑选面积最大的一个 */
function ringArea(ring: Coordinate[]): number {
  let area = 0;

  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[index + 1];
    area += x1 * y2 - x2 * y1;
  }

  return Math.abs(area / 2);
}

/**
 * 校验并规整一个环：剔除连续重复点，必要时补闭合点，点数不足则报错。
 */
function normalizeRing(
  rawRing: unknown,
  label: string,
  options: GeometryOptions,
  warnings: string[],
): RingResult {
  if (!Array.isArray(rawRing)) {
    return { ok: false, error: `${label} 不是坐标数组` };
  }

  const points: Coordinate[] = [];

  for (const point of rawRing) {
    if (!isCoordinate(point)) {
      return { ok: false, error: `${label} 含有非法的坐标值` };
    }

    points.push([point[0], point[1]]);
  }

  if (points.length === 0) {
    return { ok: false, error: `${label} 是空环` };
  }

  const deduped: Coordinate[] = [];
  for (const point of points) {
    const previous = deduped[deduped.length - 1];

    if (!previous || !samePoint(previous, point)) {
      deduped.push(point);
    }
  }

  if (deduped.length >= 2 && samePoint(deduped[0], deduped[deduped.length - 1])) {
    deduped.pop();
  }

  if (deduped.length < 3) {
    return { ok: false, error: `${label} 至少需要 3 个不同顶点` };
  }

  const closed: Coordinate[] = [...deduped, [...deduped[0]]];

  if (closed.length !== points.length) {
    warnings.push(`${label} 未闭合或含重复点，已自动规整。`);
  }

  const needsReproject =
    options.from !== null &&
    options.to !== null &&
    options.from.trim().toUpperCase() !== options.to.trim().toUpperCase();

  if (!needsReproject) {
    return { ok: true, ring: closed };
  }

  const projected = closed.map(([x, y]) => proj4(options.from!, options.to!, [x, y]));

  if (projected.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) {
    return { ok: false, error: `${label} 重投影后出现非法坐标` };
  }

  return { ok: true, ring: projected as Coordinate[] };
}

function parsePolygonCoordinates(
  coordinates: unknown,
  label: string,
  options: GeometryOptions,
  warnings: string[],
): RingsResult {
  if (!Array.isArray(coordinates) || coordinates.length === 0) {
    return { ok: false, error: `${label} 的 coordinates 为空` };
  }

  const rings: FenceRings = [];

  for (let index = 0; index < coordinates.length; index += 1) {
    const ringLabel = index === 0 ? `${label} 外环` : `${label} 第 ${index} 个内环`;
    const normalized = normalizeRing(coordinates[index], ringLabel, options, warnings);

    if (!normalized.ok) {
      return { ok: false, error: normalized.error };
    }

    rings.push(normalized.ring);
  }

  return { ok: true, rings };
}

function pickPolygonRings(
  geometryType: 'Polygon' | 'MultiPolygon',
  coordinates: unknown,
  options: GeometryOptions,
  warnings: string[],
): RingsResult {
  if (geometryType === 'Polygon') {
    return parsePolygonCoordinates(coordinates, 'Polygon', options, warnings);
  }

  if (!Array.isArray(coordinates) || coordinates.length === 0) {
    return { ok: false, error: 'MultiPolygon 的 coordinates 为空' };
  }

  let best: FenceRings | null = null;
  let bestArea = -1;

  for (const polygon of coordinates) {
    const parsed = parsePolygonCoordinates(polygon, 'MultiPolygon', options, warnings);

    if (!parsed.ok) {
      continue;
    }

    const area = ringArea(parsed.rings[0]);
    if (area > bestArea) {
      bestArea = area;
      best = parsed.rings;
    }
  }

  if (!best) {
    return { ok: false, error: 'MultiPolygon 中没有可用的多边形' };
  }

  if (coordinates.length > 1) {
    warnings.push(`输入包含 ${coordinates.length} 个多边形，已取面积最大的一个作为围栏。`);
  }

  return { ok: true, rings: best };
}

function resolveReprojection(reproject: { from: string; to: string } | null): string[] {
  if (!reproject) {
    return [];
  }

  const errors: string[] = [];

  for (const code of [reproject.from, reproject.to]) {
    ensureProjectionRegistered(code);

    if (!proj4.defs(code)) {
      errors.push(`缺少坐标系定义 ${code}，无法重投影；请先加载该坐标系的影像。`);
    }
  }

  return errors;
}

/**
 * 解析 GeoJSON 文本/对象为围栏。
 *
 * @param options.reproject 仅在跨坐标系导入时提供，例如 `{ from: 'EPSG:4326', to: 'EPSG:4549' }`
 */
export function parseFenceGeoJson(
  input: string | unknown,
  options: { reproject?: { from: string; to: string } | null } = {},
): FenceGeoJsonImportResult {
  const warnings: string[] = [];

  let json: unknown = input;

  if (typeof input === 'string') {
    try {
      json = JSON.parse(input);
    } catch {
      return { ok: false, errors: ['文件不是合法的 JSON'] };
    }
  }

  if (!isRecord(json)) {
    return { ok: false, errors: ['GeoJSON 内容不是对象'] };
  }

  const projectMember = json[GEOJSON_PROJECT_MEMBER] ?? null;
  const hasProjectMember = projectMember !== null;

  const reproject = options.reproject ?? null;
  const reprojectionErrors = resolveReprojection(reproject);

  if (reprojectionErrors.length > 0) {
    return { ok: false, errors: reprojectionErrors };
  }

  const geometryOptions: GeometryOptions = {
    from: reproject?.from ?? null,
    to: reproject?.to ?? null,
  };

  const type = json.type;

  if (type === 'Polygon' || type === 'MultiPolygon') {
    const parsed = pickPolygonRings(type, json.coordinates, geometryOptions, warnings);

    return parsed.ok
      ? {
          ok: true,
          rings: parsed.rings,
          projectMember,
          warnings,
          source: { geometryType: type, featureCount: 1 },
        }
      : { ok: false, errors: [parsed.error] };
  }

  if (type === 'Feature') {
    const geometry = isRecord(json.geometry) ? json.geometry : null;
    const geometryType = geometry?.type;

    if (geometryType !== 'Polygon' && geometryType !== 'MultiPolygon') {
      return { ok: false, errors: ['该要素不是多边形几何，无法作为围栏'] };
    }

    const parsed = pickPolygonRings(geometryType, geometry?.coordinates, geometryOptions, warnings);

    return parsed.ok
      ? {
          ok: true,
          rings: parsed.rings,
          projectMember,
          warnings,
          source: { geometryType, featureCount: 1 },
        }
      : { ok: false, errors: [parsed.error] };
  }

  if (type !== 'FeatureCollection') {
    return { ok: false, errors: [`不支持的 GeoJSON 类型：${String(type)}`] };
  }

  const features = Array.isArray(json.features) ? json.features : [];
  const polygons: Array<{ geometryType: 'Polygon' | 'MultiPolygon'; coordinates: unknown }> = [];

  for (const feature of features) {
    if (!isRecord(feature) || !isRecord(feature.geometry)) {
      continue;
    }

    const geometryType = feature.geometry.type;

    if (geometryType === 'Polygon' || geometryType === 'MultiPolygon') {
      polygons.push({ geometryType, coordinates: feature.geometry.coordinates });
    }
  }

  if (polygons.length === 0) {
    if (hasProjectMember) {
      return { ok: true, rings: null, projectMember, warnings, source: null };
    }

    return { ok: false, errors: ['文件里没有可用的多边形要素'] };
  }

  // 本工具导出的网格文件是"多个 Polygon"，不能当围栏用：
  // 带内嵌配方时只还原设置（围栏以配方为准），没有则明确报错
  if (polygons.length > 1) {
    if (hasProjectMember) {
      warnings.push(
        `文件包含 ${polygons.length} 个多边形（网格要素），围栏将采用内嵌工程信息中的几何。`,
      );
      return { ok: true, rings: null, projectMember, warnings, source: null };
    }

    return {
      ok: false,
      errors: [
        `文件包含 ${polygons.length} 个多边形，看起来是网格导出而不是围栏。请导入 fence.geojson，或在其顶层加入 ${GEOJSON_PROJECT_MEMBER} 以还原工程设置。`,
      ],
    };
  }

  const first = polygons[0];
  const parsed = pickPolygonRings(first.geometryType, first.coordinates, geometryOptions, warnings);

  if (!parsed.ok) {
    if (hasProjectMember) {
      return { ok: true, rings: null, projectMember, warnings, source: null };
    }

    return { ok: false, errors: [parsed.error] };
  }

  return {
    ok: true,
    rings: parsed.rings,
    projectMember,
    warnings,
    source: { geometryType: first.geometryType, featureCount: features.length },
  };
}
