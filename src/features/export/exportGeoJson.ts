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

export function createGridGeoJson(
  cells: GridCell[],
  summary: GridSummary,
): GeoJsonFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: cells.map((cell) => ({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: cell.polygon,
      },
      properties: {
        id: cell.id,
        row: cell.row,
        col: cell.col,
        centerX: cell.center[0],
        centerY: cell.center[1],
        cellSize: summary.cellSize,
      },
    })),
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
