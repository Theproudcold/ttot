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
};

export function createFenceGeoJson(fence: FenceFeature): GeoJsonFeatureCollection {
  return {
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
  };
}

import type { RasterClassificationLayer, RasterRuleClassificationLayer } from '@/shared/types/raster';
import {
  normalizeApplicationRateBasis,
  normalizeApplicationRateUnit,
  resolveCellAmount,
} from '@/shared/geo/applicationRate';
import { EXPORT_RULE_SEMANTICS, findRuleMatch } from '@/shared/geo/classificationRuleMatching';

export function createGridGeoJson(
  cells: GridCell[],
  summary: GridSummary,
  activeLayer?: RasterClassificationLayer | null,
): GeoJsonFeatureCollection {
  const isRulesMode = activeLayer?.mode === 'rules';
  const rules = isRulesMode ? (activeLayer as RasterRuleClassificationLayer).rules : [];
  const cellAreaM2 = summary.cellSize > 0 ? summary.cellSize * summary.cellSize : 0;

  return {
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
           const match = findRuleMatch(rules, cell.aggregation.outputValue, EXPORT_RULE_SEMANTICS);
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
  };
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
