import type { ProjectSnapshotV1 } from '@/features/project/projectSnapshot';
import { GEOJSON_PROJECT_MEMBER } from '@/shared/geo/geojsonImport';
import type { FenceFeature } from '@/shared/types/fence';
import type { GridCell, GridSummary } from '@/shared/types/grid';

type GeoJsonFeature = {
  type: 'Feature';
  geometry: {
    type: 'Polygon';
    coordinates: number[][][];
  };
  properties: Record<string, unknown>;
};

type GeoJsonFeatureCollection = {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
} & Record<string, unknown>;

/**
 * 把工程配方挂到要素集合的 foreign member 上。
 * GeoJSON 规范允许额外成员，因此不影响其他软件读取几何与属性；
 * 本工具重新导入该文件时即可据此还原设置。
 */
function withProjectMember(
  collection: GeoJsonFeatureCollection,
  projectSnapshot?: ProjectSnapshotV1 | null,
): GeoJsonFeatureCollection {
  if (!projectSnapshot) {
    return collection;
  }

  return { ...collection, [GEOJSON_PROJECT_MEMBER]: projectSnapshot };
}

export function createFenceGeoJson(
  fence: FenceFeature,
  projectSnapshot?: ProjectSnapshotV1 | null,
): GeoJsonFeatureCollection {
  return withProjectMember(
    {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: fence.geometry,
          properties: {
            area: fence.summary.area,
            bbox: fence.summary.bbox,
            vertexCount: fence.summary.vertexCount,
          },
        },
      ],
    },
    projectSnapshot,
  );
}

import type { RasterClassificationLayer, RasterRuleClassificationLayer } from '@/shared/types/raster';
import {
  normalizeApplicationRateBasis,
  normalizeApplicationRateUnit,
  resolveCellAmount,
} from '@/shared/geo/applicationRate';
import { findRuleMatch } from '@/shared/geo/classificationRuleMatching';

export function createGridGeoJson(
  cells: GridCell[],
  summary: GridSummary,
  activeLayer?: RasterClassificationLayer | null,
  projectSnapshot?: ProjectSnapshotV1 | null,
): GeoJsonFeatureCollection {
  const isRulesMode = activeLayer?.mode === 'rules';
  const rules = isRulesMode ? (activeLayer as RasterRuleClassificationLayer).rules : [];
  const cellAreaM2 = summary.cellSize > 0 ? summary.cellSize * summary.cellSize : 0;

  return withProjectMember(
    {
      type: 'FeatureCollection',
    features: cells.map((cell) => {
      const properties: Record<string, unknown> = {
        id: cell.id,
        row: cell.row,
        col: cell.col,
        centerX: cell.center[0],
        centerY: cell.center[1],
        cellSize: summary.cellSize,
      };

      if (cell.aggregation?.outputValue != null) {
        properties.aggregationValue = cell.aggregation.outputValue;
        properties.meanValue = cell.aggregation.meanValue;
        if (rules.length > 0) {
           const match = findRuleMatch(rules, cell.aggregation.outputValue);
           if (match) {
             // fertilizerAmount 始终是"该网格单元的用量"，下游口径不变；
             // 只有按面积计量的规则才额外记录原始速率与单位以便追溯。
             const cellAmount = resolveCellAmount(match.rule, cellAreaM2);
             if (cellAmount !== null) {
               properties.fertilizerAmount = cellAmount;

               if (normalizeApplicationRateBasis(match.rule.applicationRateBasis) === 'per-area') {
                 properties.applicationRate = match.rule.applicationRate ?? null;
                 properties.applicationRateUnit = normalizeApplicationRateUnit(match.rule.applicationRateUnit);
                 properties.cellAreaM2 = cellAreaM2;
               }
             }
           }
        }
      }

      return {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: cell.polygon,
        },
        properties,
      };
    }),
    },
    projectSnapshot,
  );
}

export function downloadGeoJson(data: GeoJsonFeatureCollection, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/geo+json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
