import { useState, useEffect } from 'react';
import { useDebounce } from '@/shared/hooks/useDebounce';

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
  const stopInteraction = useFenceStore((state) => state.stopInteraction);
  const clearFence = useFenceStore((state) => state.clearFence);
  const resetFence = useFenceStore((state) => state.reset);
  const cellSize = useGridStore((state) => state.cellSize);
  const rotation = useGridStore((state) => state.rotation);
  const gridSummary = useGridStore((state) => state.summary);
  const gridCells = useGridStore((state) => state.cells);
  const setCellSize = useGridStore((state) => state.setCellSize);
  const setRotation = useGridStore((state) => state.setRotation);
  const resetGrid = useGridStore((state) => state.reset);
  const gridRenderSettings = useMapUiStore((state) => state.gridRenderSettings);
  const setGridRenderSettings = useMapUiStore((state) => state.setGridRenderSettings);

  const classificationLayers = useMapUiStore((state) => state.classificationLayers);
  const activeClassificationLayerId = useMapUiStore((state) => state.activeClassificationLayerId);
  const activeClassificationLayer =
    classificationLayers.find((layer) => layer.id === activeClassificationLayerId) ??
    classificationLayers[0] ??
    null;

  const [localCellSize, setLocalCellSize] = useState(String(cellSize));
  const debouncedCellSize = useDebounce(localCellSize, 300);
  const [localRotation, setLocalRotation] = useState(String(rotation));
  const debouncedRotation = useDebounce(localRotation, 300);

  useEffect(() => {
    setLocalCellSize(String(cellSize));
  }, [cellSize]);

  useEffect(() => {
    const nextValue = Number(debouncedCellSize);
    if (Number.isFinite(nextValue) && nextValue > 0 && nextValue !== cellSize) {
      setCellSize(nextValue);
    }
  }, [debouncedCellSize, cellSize, setCellSize]);

  useEffect(() => {
    setLocalRotation(String(rotation));
  }, [rotation]);

  useEffect(() => {
    const nextValue = Number(debouncedRotation);
    if (Number.isFinite(nextValue) && nextValue !== rotation) {
      setRotation(((nextValue % 360) + 360) % 360);
    }
  }, [debouncedRotation, rotation, setRotation]);

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
        <div className="metric-section">
          <h4 className="metric-section__title">基本属性</h4>
          <dl className="metric-list metric-list--two-col">
            <div className="metric-item">
              <dt className="metric-label">文件名</dt>
              <dd className="metric-value" title={metadata?.fileName ?? sourceLabel}>{metadata?.fileName ?? sourceLabel}</dd>
            </div>
            <div className="metric-item">
              <dt className="metric-label">尺寸</dt>
              <dd className="metric-value">{metadata ? `${metadata.width} x ${metadata.height}` : '--'}</dd>
            </div>
          </dl>
        </div>

        <div className="metric-section">
          <h4 className="metric-section__title">空间参考</h4>
          <dl className="metric-list metric-list--two-col">
            <div className="metric-item">
              <dt className="metric-label">地理参考</dt>
              <dd className="metric-value">
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
              <dt className="metric-label">CRS</dt>
              <dd className="metric-value">{metadata?.crsCode ?? '--'}</dd>
            </div>
            <div className="metric-item">
              <dt className="metric-label">像元大小</dt>
              <dd className="metric-value">{metadata ? formatCellSize(metadata.cellSize.x, metadata.cellSize.unit) : '--'}</dd>
            </div>
            <div className="metric-item metric-item--full">
              <dt className="metric-label">原始范围</dt>
              <dd className="metric-value">{formatSourceExtent(metadata)}</dd>
            </div>
            <div className="metric-item">
              <dt className="metric-label">实际尺寸</dt>
              <dd className="metric-value">{formatRasterPhysicalSize(metadata)}</dd>
            </div>
          </dl>
        </div>

        <div className="metric-section">
          <h4 className="metric-section__title">处理状态</h4>
          <dl className="metric-list metric-list--two-col">
            <div className="metric-item">
              <dt className="metric-label">读取状态</dt>
              <dd className="metric-value">{loadingPhase}</dd>
            </div>
            <div className="metric-item">
              <dt className="metric-label">读取进度</dt>
              <dd className="metric-value">{loadingProgress === null ? '--' : `${loadingProgress}%`}</dd>
            </div>
            <div className="metric-item">
              <dt className="metric-label">有效区域</dt>
              <dd className="metric-value">
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
      </div>

      <h3>围栏工具</h3>
      <div className="card">
        <div className="toolbar-row">
          <button
            type="button"
            className={`toolbar-button${fenceMode === 'draw' ? ' toolbar-button--active' : ''}`}
            onClick={startDraw}
            disabled={fenceMode === 'draw'}
          >
            {fenceMode === 'draw' ? '绘制中…' : '开始绘制'}
          </button>
          <button
            type="button"
            className={`toolbar-button${fenceMode === 'edit' ? ' toolbar-button--active' : ''}`}
            onClick={startEdit}
            disabled={!fence || fenceMode === 'edit'}
          >
            {fenceMode === 'edit' ? '编辑中…' : '编辑围栏'}
          </button>
          {fenceMode === 'draw' && (
            <button
              type="button"
              className="toolbar-button toolbar-button--ghost"
              onClick={stopInteraction}
            >
              取消
            </button>
          )}
          {fenceMode === 'edit' && (
            <>
              <button
                type="button"
                className="toolbar-button toolbar-button--active"
                onClick={stopInteraction}
              >
                完成编辑
              </button>
              <button
                type="button"
                className="toolbar-button toolbar-button--ghost"
                onClick={stopInteraction}
              >
                取消
              </button>
            </>
          )}
          <button
            type="button"
            className="toolbar-button toolbar-button--ghost"
            onClick={clearFence}
            disabled={!fence || fenceMode !== 'idle'}
          >
            清空围栏
          </button>
        </div>
        <p className="toolbar-hint">
          {fenceMode === 'idle' && !fence && '尚未绘制围栏，点击「开始绘制」后在地图上单击添加顶点、双击完成。'}
          {fenceMode === 'idle' && fence && '围栏已就绪，可继续编辑或清空后重新绘制。'}
          {fenceMode === 'draw' && '正在绘制：单击地图添加顶点，双击完成绘制。'}
          {fenceMode === 'edit' && '正在编辑：拖动顶点调整围栏形状，修改自动保存。'}
        </p>
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
          value={localCellSize}
          onChange={(event) => setLocalCellSize(event.target.value)}
        />
        <label className="field-label" htmlFor="grid-rotation" style={{ marginTop: 12, display: 'block' }}>
          网格方向（°）
        </label>
        <input
          id="grid-rotation"
          className="field-input"
          type="number"
          min="-180"
          max="180"
          step="1"
          value={localRotation}
          onChange={(event) => setLocalRotation(event.target.value)}
        />
        <div className="metric-section metric-section--compact" style={{ marginTop: 12 }}>
          <dl className="metric-list metric-list--two-col">
            <div className="metric-item">
              <dt className="metric-label">网格比例</dt>
              <dd className="metric-value">{formatGridRatio(cellSize, metadata)}</dd>
            </div>
            <div className="metric-item">
              <dt className="metric-label">网格方向</dt>
              <dd className="metric-value">{gridSummary?.rotation ?? rotation}°</dd>
            </div>
            <div className="metric-item">
              <dt className="metric-label">网格单位</dt>
              <dd className="metric-value">米</dd>
            </div>
            <div className="metric-item">
              <dt className="metric-label">预计网格</dt>
              <dd className="metric-value">{gridSummary?.totalCells ?? '--'}</dd>
            </div>
          </dl>
        </div>

        <div className="metric-section metric-section--compact" style={{ marginTop: 12 }}>
          <h4 className="metric-section__title" style={{ marginBottom: 8, fontSize: 14 }}>渲染样式</h4>
          <div className="field-row" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <input
              id="grid-use-classification-colors"
              type="checkbox"
              checked={gridRenderSettings.useClassificationColors}
              onChange={(e) => setGridRenderSettings({ useClassificationColors: e.target.checked })}
            />
            <label htmlFor="grid-use-classification-colors" style={{ fontSize: 14 }}>使用分类颜色</label>
          </div>
          {!gridRenderSettings.useClassificationColors && (
            <div className="grid-render-custom" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 12px' }}>
              <div>
                <label className="field-label" style={{ fontSize: 12 }}>填充颜色</label>
                <input
                  type="color"
                  value={gridRenderSettings.fillColor}
                  onChange={(e) => setGridRenderSettings({ fillColor: e.target.value })}
                  style={{ width: '100%', height: 32, padding: 0, border: 'none' }}
                />
              </div>
              <div>
                <label className="field-label" style={{ fontSize: 12 }}>填充透明度</label>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={gridRenderSettings.fillOpacity}
                  onChange={(e) => setGridRenderSettings({ fillOpacity: Number(e.target.value) })}
                  className="field-input"
                />
              </div>
              <div>
                <label className="field-label" style={{ fontSize: 12 }}>边框颜色</label>
                <input
                  type="color"
                  value={gridRenderSettings.strokeColor}
                  onChange={(e) => setGridRenderSettings({ strokeColor: e.target.value })}
                  style={{ width: '100%', height: 32, padding: 0, border: 'none' }}
                />
              </div>
              <div>
                <label className="field-label" style={{ fontSize: 12 }}>边框透明度</label>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={gridRenderSettings.strokeOpacity}
                  onChange={(e) => setGridRenderSettings({ strokeOpacity: Number(e.target.value) })}
                  className="field-input"
                />
              </div>
              <div style={{ gridColumn: 'span 2' }}>
                <label className="field-label" style={{ fontSize: 12 }}>边框宽度</label>
                <input
                  type="number"
                  min={0}
                  max={10}
                  step={0.5}
                  value={gridRenderSettings.strokeWidth}
                  onChange={(e) => setGridRenderSettings({ strokeWidth: Number(e.target.value) })}
                  className="field-input"
                />
              </div>
            </div>
          )}
        </div>
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
