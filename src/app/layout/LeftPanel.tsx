import { useState } from 'react';

import {
  createFenceGeoJson,
  createGridGeoJson,
  downloadGeoJson,
} from '@/features/export/exportGeoJson';
import { downloadExportedGeoTiff, exportFenceGeoTiff } from '@/features/export/exportGeoTiff';
import { useLoadingStore } from '@/features/loading/loadingStore';
import { useFenceStore } from '@/features/fence/fenceStore';
import { useGridStore } from '@/features/grid/gridStore';
import { useMapUiStore } from '@/features/map/mapUiStore';
import { useRasterStore } from '@/features/map/rasterStore';
import type { RasterMetadata } from '@/shared/types/raster';

function formatCellSize(value: number, unit: string): string {
  if (!value) {
    return '--';
  }

  return `${value.toFixed(4)} ${unit}`;
}

function getCoordinateDecimals(metadata: RasterMetadata | null | undefined): number {
  return metadata?.coordinateDisplayMode === 'geographic' ? 6 : 2;
}

function formatSourceExtent(metadata: RasterMetadata | null | undefined): string {
  if (!metadata) {
    return '--';
  }

  const decimals = getCoordinateDecimals(metadata);
  return metadata.boundingBox.map((value) => value.toFixed(decimals)).join(', ');
}

function formatRasterPhysicalSize(metadata: RasterMetadata | null | undefined): string {
  if (!metadata) {
    return '--';
  }

  return `${metadata.metricWidth.toFixed(2)}m x ${metadata.metricHeight.toFixed(2)}m`;
}

function formatGridRatio(cellSize: number, metadata: RasterMetadata | null | undefined): string {
  if (!metadata || cellSize <= 0 || metadata.metricWidth <= 0 || metadata.metricHeight <= 0) {
    return '--';
  }

  const widthRatio = (cellSize / metadata.metricWidth) * 100;
  const heightRatio = (cellSize / metadata.metricHeight) * 100;
  return `${widthRatio.toFixed(1)}% / ${heightRatio.toFixed(1)}%`;
}

export function LeftPanel() {
  const [geoTiffExportMessage, setGeoTiffExportMessage] = useState<string | null>(null);
  const loading = useLoadingStore();
  const sourceLabel = useRasterStore((state) => state.sourceLabel);
  const sourceFile = useRasterStore((state) => state.sourceFile);
  const selectFile = useRasterStore((state) => state.selectFile);
  const resetRaster = useRasterStore((state) => state.reset);
  const resetMapUi = useMapUiStore((state) => state.reset);
  const metadata = useRasterStore((state) => state.metadata);
  const status = useRasterStore((state) => state.status);
  const validityStatus = useRasterStore((state) => state.validityStatus);
  const loadingProgress = useRasterStore((state) => state.loadingProgress);
  const loadingPhase = useRasterStore((state) => state.loadingPhase);
  const fence = useFenceStore((state) => state.fence);
  const fenceMode = useFenceStore((state) => state.mode);
  const startDraw = useFenceStore((state) => state.startDraw);
  const startEdit = useFenceStore((state) => state.startEdit);
  const clearFence = useFenceStore((state) => state.clearFence);
  const resetFence = useFenceStore((state) => state.reset);
  const cellSize = useGridStore((state) => state.cellSize);
  const gridSummary = useGridStore((state) => state.summary);
  const gridCells = useGridStore((state) => state.cells);
  const setCellSize = useGridStore((state) => state.setCellSize);
  const resetGrid = useGridStore((state) => state.reset);

  const classificationLayers = useMapUiStore((state) => state.classificationLayers);
  const activeClassificationLayerId = useMapUiStore((state) => state.activeClassificationLayerId);
  const activeClassificationLayer =
    classificationLayers.find((layer) => layer.id === activeClassificationLayerId) ??
    classificationLayers[0] ??
    null;

  const handleGeoTiffExport = async () => {
    if (!sourceFile || !fence || loading.active) {
      return;
    }

    loading.start('正在导出 GeoTIFF...');
    setGeoTiffExportMessage(null);

    try {
      const { blob, filename } = await exportFenceGeoTiff({
        file: sourceFile,
        fence,
        gridCellSize: cellSize,
        activeClassificationLayer,
        metricTransform: metadata?.metricTransform ?? null,
      });
      await downloadExportedGeoTiff(blob, filename);
      setGeoTiffExportMessage('GeoTIFF 导出完成');
    } catch (error) {
      const detail = error instanceof Error ? error.message : '请稍后重试';
      setGeoTiffExportMessage(`GeoTIFF 导出失败：${detail}`);
    } finally {
      loading.stop();
    }
  };

  return (
    <aside className="panel" aria-label="left-panel">
      <h2>文件信息</h2>
      <div className="card">
        <div className="file-select-zone">
          {!sourceFile ? (
            <>
              <label className="toolbar-button" htmlFor="raster-file-input" style={{ display: 'inline-block', textAlign: 'center', width: '100%' }}>
                选择 TIFF 文件
              </label>
              <input
                id="raster-file-input"
                className="visually-hidden"
                type="file"
                accept=".tif,.tiff,image/tiff"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) {
                    return;
                  }

                  resetFence();
                  resetGrid();
                  resetMapUi();
                  setGeoTiffExportMessage(null);
                  selectFile(file);
                }}
              />
            </>
          ) : (
            <div className="file-selected-row">
              <span className="file-selected-name" title={sourceLabel}>{sourceLabel}</span>
              <button
                type="button"
                className="toolbar-button toolbar-button--ghost"
                onClick={() => {
                  resetRaster();
                  resetFence();
                  resetGrid();
                  resetMapUi();
                  setGeoTiffExportMessage(null);
                }}
              >
                移除
              </button>
            </div>
          )}
        </div>
        <dl className="metric-list">
          <div className="metric-item">
            <dt className="metric-label">文件名</dt>
            <dd>{metadata?.fileName ?? sourceLabel}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">地理参考</dt>
            <dd>
              {status === 'ready'
                ? '已识别'
                : status === 'error'
                  ? '失败'
                  : sourceLabel === '未选择文件'
                    ? '等待上传'
                    : '读取中'}
            </dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">尺寸</dt>
            <dd>{metadata ? `${metadata.width} x ${metadata.height}` : '--'}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">CRS</dt>
            <dd>{metadata?.crsCode ?? '--'}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">像元大小</dt>
            <dd>{metadata ? formatCellSize(metadata.cellSize.x, metadata.cellSize.unit) : '--'}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">原始范围</dt>
            <dd>{formatSourceExtent(metadata)}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">实际尺寸</dt>
            <dd>{formatRasterPhysicalSize(metadata)}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">网格比例</dt>
            <dd>{formatGridRatio(cellSize, metadata)}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">网格单位</dt>
            <dd>米</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">读取状态</dt>
            <dd>{loadingPhase}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">读取进度</dt>
            <dd>{loadingProgress === null ? '--' : `${loadingProgress}%`}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">有效区域</dt>
            <dd>
              {validityStatus === 'ready'
                ? '已就绪'
                : validityStatus === 'loading'
                  ? '后台处理中'
                  : validityStatus === 'error'
                    ? '提取失败'
                    : '--'}
            </dd>
          </div>
        </dl>
      </div>

      <h3>围栏工具</h3>
      <div className="card">
        <div className="toolbar-row">
          <button type="button" className="toolbar-button" onClick={startDraw}>
            开始绘制
          </button>
          <button
            type="button"
            className="toolbar-button"
            onClick={startEdit}
            disabled={!fence}
          >
            编辑围栏
          </button>
          <button
            type="button"
            className="toolbar-button toolbar-button--ghost"
            onClick={clearFence}
            disabled={!fence}
          >
            清空围栏
          </button>
        </div>
        <p className="toolbar-hint">当前模式：{fenceMode}</p>
      </div>

      <h3>网格参数</h3>
      <div className="card">
        <label className="field-label" htmlFor="grid-cell-size">
          网格尺寸（米）
        </label>
        <input
          id="grid-cell-size"
          className="field-input"
          type="number"
          min="0.1"
          step="0.1"
          value={cellSize}
          onChange={(event) => {
            const nextValue = Number(event.target.value);
            if (Number.isFinite(nextValue) && nextValue > 0) {
              setCellSize(nextValue);
            }
          }}
        />
        <p className="toolbar-hint">预计网格：{gridSummary?.totalCells ?? '--'}</p>
        <div className="toolbar-row toolbar-row--spaced">
          <button
            type="button"
            className="toolbar-button toolbar-button--ghost"
            disabled={!fence || loading.active}
            onClick={() => {
              if (!fence) return;
              loading.start('正在导出围栏...');
              try {
                downloadGeoJson(createFenceGeoJson(fence), 'fence.geojson');
              } finally {
                loading.stop();
              }
            }}
          >
            导出围栏
          </button>
          <button
            type="button"
            className="toolbar-button toolbar-button--ghost"
            disabled={!gridSummary || gridCells.length === 0 || loading.active}
            onClick={() => {
              if (!gridSummary || gridCells.length === 0) return;
              loading.start('正在导出网格...');
              try {
                downloadGeoJson(createGridGeoJson(gridCells, gridSummary, activeClassificationLayer), 'grid.geojson');
              } finally {
                loading.stop();
              }
            }}
          >
            导出网格
          </button>
          <button
            type="button"
            className="toolbar-button toolbar-button--ghost"
            disabled={!sourceFile || !fence || loading.active}
            onClick={() => {
              void handleGeoTiffExport();
            }}
          >
            {loading.active ? '处理中...' : '导出 GeoTIFF'}
          </button>
        </div>
        {geoTiffExportMessage ? <p className="toolbar-hint">{geoTiffExportMessage}</p> : null}
      </div>
    </aside>
  );
}
