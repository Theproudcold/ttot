/**
 * 从 GeoJSON 顶层 foreign member 读取工程配方。
 *
 * 单独成文件是为了不让 `projectSnapshot.ts` 反向依赖 `shared/geo/geojsonImport`
 * （后者会引入 proj4）：只有真正处理 GeoJSON 导入的调用方才需要付出这份代价。
 */

import { GEOJSON_PROJECT_MEMBER } from '@/shared/geo/geojsonImport';

import { validateProjectSnapshot, type ProjectSnapshotV1 } from './projectSnapshot';

export type GeoJsonProjectReadResult = {
  snapshot: ProjectSnapshotV1 | null;
  warnings: string[];
};

export function readProjectSnapshotFromGeoJson(json: unknown): GeoJsonProjectReadResult {
  const warnings: string[] = [];

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { snapshot: null, warnings };
  }

  const raw = (json as Record<string, unknown>)[GEOJSON_PROJECT_MEMBER];

  if (raw === undefined || raw === null) {
    return { snapshot: null, warnings };
  }

  const parsed = validateProjectSnapshot(raw);

  if (!parsed.ok) {
    warnings.push(`文件内嵌的工程信息无法使用：${parsed.errors[0] ?? '格式不合法'}`);
    return { snapshot: null, warnings };
  }

  return { snapshot: parsed.snapshot, warnings: [...warnings, ...parsed.warnings] };
}
