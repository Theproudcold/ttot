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

export function createGridGeoJson(
  cells: GridCell[],
  summary: GridSummary,
  activeLayer?: RasterClassificationLayer | null,
): GeoJsonFeatureCollection {
  const isRulesMode = activeLayer?.mode === 'rules';
  const rules = isRulesMode ? (activeLayer as RasterRuleClassificationLayer).rules : [];

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

      if (cell.aggregation?.meanValue != null) {
        properties.meanValue = cell.aggregation.meanValue;
        if (rules.length > 0) {
           for (const rule of rules) {
             if (cell.aggregation.meanValue >= rule.min && (rule.max == null || cell.aggregation.meanValue <= rule.max)) {
                if (rule.applicationRate != null) {
                  properties.fertilizerAmount = rule.applicationRate;
                }
                break;
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
