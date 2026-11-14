import { useState } from 'react';

import {
  createFenceGeoJson,
  createGridGeoJson,
  downloadGeoJson,
} from '@/features/export/exportGeoJson';
import { downloadExportedGeoTiff, exportFenceGeoTiff } from '@/features/export/exportGeoTiff';
import { exportProjectSnapshot } from '@/features/project/projectSnapshot';
import { useFenceStore } from '@/features/fence/fenceStore';
import { useGridStore } from '@/features/grid/gridStore';
import { useLoadingStore } from '@/features/loading/loadingStore';
import { useMapUiStore } from '@/features/map/mapUiStore';
import { useRasterStore } from '@/features/map/rasterStore';

export function TopBar() {
  const loading = useLoadingStore();
  const metadata = useRasterStore((state) => state.metadata);
  const sourceFile = useRasterStore((state) => state.sourceFile);
  const fence = useFenceStore((state) => state.fence);
  const cellSize = useGridStore((state) => state.cellSize);
  const rotation = useGridStore((state) => state.rotation);
  const aggregationMode = useGridStore((state) => state.aggregationMode);
  const gridSummary = useGridStore((state) => state.summary);
  const gridCells = useGridStore((state) => state.cells);

  const classificationLayers = useMapUiStore((state) => state.classificationLayers);
  const activeClassificationLayerId = useMapUiStore((state) => state.activeClassificationLayerId);
  const activeClassificationLayer =
    classificationLayers.find((layer) => layer.id === activeClassificationLayerId) ??
    classificationLayers[0] ??
    null;

  const [geoTiffMessage, setGeoTiffMessage] = useState<string | null>(null);

  const handleExportFence = () => {
    if (!fence) return;
    loading.start('正在导出围栏...');
    try {
      downloadGeoJson(createFenceGeoJson(fence), 'fence.geojson');
    } finally {
      loading.stop();
    }
  };

  const handleExportGrid = () => {
    if (!gridSummary || gridCells.length === 0) return;
    loading.start('正在导出网格...');
    try {
      downloadGeoJson(
        createGridGeoJson(gridCells, gridSummary, activeClassificationLayer),
        'grid.geojson',
      );
    } finally {
      loading.stop();
    }
  };

  const handleExportGeoTiff = async () => {
    if (!sourceFile || !fence || loading.active) {
      return;
    }

    loading.start('正在导出 GeoTIFF...');
    setGeoTiffMessage(null);

    try {
      // 把当前配方内嵌进导出文件：重新导入该文件即可还原设置
      const raster = useRasterStore.getState();
      const mapUi = useMapUiStore.getState();
      const projectSnapshot = exportProjectSnapshot({
        sourceFile,
        sourceLabel: raster.sourceLabel,
        metadata,
        fenceRings: fence.geometry.coordinates,
        grid: { cellSize, rotation, aggregationMode },
        classification: {
          layers: classificationLayers,
          activeLayerId: activeClassificationLayerId,
          visibleLayerId: mapUi.visibleClassificationLayerId,
        },
        view: {
          layers: mapUi.layers,
          gridRenderSettings: mapUi.gridRenderSettings,
        },
      });

      const { blob, filename, warnings } = await exportFenceGeoTiff({
        file: sourceFile,
        fence,
        gridCellSize: cellSize,
        aggregationMode,
        activeClassificationLayer,
        metricTransform: metadata?.metricTransform ?? null,
        rotationDeg: rotation,
        projectSnapshot,
      });
      await downloadExportedGeoTiff(blob, filename);
      setGeoTiffMessage(
        warnings.length > 0 ? `GeoTIFF 导出完成（${warnings.join(' ')}）` : 'GeoTIFF 导出完成',
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : '请稍后重试';
      setGeoTiffMessage(`GeoTIFF 导出失败：${detail}`);
    } finally {
      loading.stop();
    }
  };

  return (
    <header className="top-bar">
      <div className="top-bar__title">GeoTIFF 围栏网格工具</div>
      <div className="top-bar__actions">
        <div className="toolbar-row">
          <button
            type="button"
            className="toolbar-button toolbar-button--ghost"
            disabled={!fence || loading.active}
            onClick={handleExportFence}
          >
            导出围栏
          </button>
          <button
            type="button"
            className="toolbar-button toolbar-button--ghost"
            disabled={!gridSummary || gridCells.length === 0 || loading.active}
            onClick={handleExportGrid}
          >
            导出网格
          </button>
          <button
            type="button"
            className="toolbar-button toolbar-button--ghost"
            disabled={!sourceFile || !fence || loading.active}
            onClick={() => {
              void handleExportGeoTiff();
            }}
          >
            {loading.active ? '处理中...' : '导出 GeoTIFF'}
          </button>
        </div>
        {geoTiffMessage ? (
          <span className="top-bar__hint">{geoTiffMessage}</span>
        ) : null}
      </div>
    </header>
  );
}
