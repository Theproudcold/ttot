import { useState } from 'react';

import {
  createFenceGeoJson,
  createGridGeoJson,
  downloadGeoJson,
} from '@/features/export/exportGeoJson';
import { downloadExportedGeoTiff, exportFenceGeoTiff } from '@/features/export/exportGeoTiff';
import { applyProjectSnapshot } from '@/features/project/applyProjectSnapshot';
import { downloadProjectFile, readProjectFile } from '@/features/project/projectFile';
import {
  buildRestorePlan,
  exportProjectSnapshot,
  fingerprintFromFile,
} from '@/features/project/projectSnapshot';
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
  const [projectMessage, setProjectMessage] = useState<string | null>(null);

  /**
   * 当前完整配方：三个导出入口共用。
   * GeoJSON 挂在 `ttot:project` foreign member 上，GeoTIFF 写进 ImageDescription，
   * 这样无论导哪种格式，「重新导入即可还原同一套设置」都成立。
   */
  const buildProjectSnapshot = () => {
    const raster = useRasterStore.getState();
    const mapUi = useMapUiStore.getState();

    return exportProjectSnapshot({
      sourceFile: raster.sourceFile,
      sourceLabel: raster.sourceLabel,
      metadata: raster.metadata,
      fenceRings: fence?.geometry.coordinates ?? null,
      grid: { cellSize, rotation, aggregationMode },
      classification: {
        layers: mapUi.classificationLayers,
        activeLayerId: mapUi.activeClassificationLayerId,
        visibleLayerId: mapUi.visibleClassificationLayerId,
      },
      view: {
        layers: mapUi.layers,
        gridRenderSettings: mapUi.gridRenderSettings,
      },
    });
  };

  const handleExportFence = () => {
    if (!fence) return;
    loading.start('正在导出围栏...');
    try {
      downloadGeoJson(createFenceGeoJson(fence, buildProjectSnapshot()), 'fence.geojson');
    } finally {
      loading.stop();
    }
  };

  const handleExportGrid = () => {
    if (!gridSummary || gridCells.length === 0) return;
    loading.start('正在导出网格...');
    try {
      downloadGeoJson(
        createGridGeoJson(gridCells, gridSummary, activeClassificationLayer, buildProjectSnapshot()),
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
      const projectSnapshot = buildProjectSnapshot();

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

  const handleSaveProject = () => {
    setProjectMessage(null);

    try {
      const filename = downloadProjectFile(buildProjectSnapshot());
      setProjectMessage(`工程已保存：${filename}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : '请稍后重试';
      setProjectMessage(`保存工程失败：${detail}`);
    }
  };

  const handleOpenProject = async (file: File) => {
    setProjectMessage(null);

    const parsed = await readProjectFile(file);

    if (!parsed.ok) {
      setProjectMessage(`工程文件无法打开：${parsed.errors[0] ?? '格式不合法'}`);
      return;
    }

    // 与草稿恢复同一套前置校验：坐标系不一致时网格会整体偏移，不能直接套用
    const raster = useRasterStore.getState();
    const plan = buildRestorePlan({
      snapshot: parsed.snapshot,
      currentFingerprint: raster.sourceFile ? fingerprintFromFile(raster.sourceFile) : null,
      currentCrsCode: raster.metadata?.crsCode ?? null,
      currentBoundingBox: raster.metadata?.boundingBox ?? null,
    });

    if (plan.action === 'blocked') {
      setProjectMessage(plan.errors[0] ?? '工程与当前影像不匹配，已取消还原');
      return;
    }

    applyProjectSnapshot(parsed.snapshot);

    const notes = [...parsed.warnings, ...plan.warnings];
    setProjectMessage(notes.length > 0 ? `工程已打开（${notes.join(' ')}）` : '工程已打开');
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
          <button
            type="button"
            className="toolbar-button"
            onClick={handleSaveProject}
          >
            保存工程
          </button>
          <label
            className="toolbar-button toolbar-button--ghost"
            htmlFor="project-file-input"
            style={{ cursor: 'pointer' }}
          >
            打开工程
          </label>
          <input
            id="project-file-input"
            className="visually-hidden"
            type="file"
            accept=".json,application/json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) {
                return;
              }

              void handleOpenProject(file);
            }}
          />
        </div>
        {geoTiffMessage ? (
          <span className="top-bar__hint">{geoTiffMessage}</span>
        ) : null}
        {projectMessage ? (
          <span className="top-bar__hint">{projectMessage}</span>
        ) : null}
      </div>
    </header>
  );
}
