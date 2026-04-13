import {
  createFenceGeoJson,
  createGridGeoJson,
  downloadGeoJson,
} from '@/features/export/exportGeoJson';
import { useFenceStore } from '@/features/fence/fenceStore';
import { useGridStore } from '@/features/grid/gridStore';
import { useMapUiStore } from '@/features/map/mapUiStore';
import { useRasterStore } from '@/features/map/rasterStore';

function formatCellSize(value: number, unit: string): string {
  if (!value) {
    return '--';
  }

  return `${value.toFixed(4)} ${unit}`;
}

function formatRasterPhysicalSize(bbox: [number, number, number, number] | null | undefined): string {
  if (!bbox) {
    return '--';
  }

  const width = bbox[2] - bbox[0];
  const height = bbox[3] - bbox[1];
  return `${width.toFixed(2)}m x ${height.toFixed(2)}m`;
}

export function LeftPanel() {
  const sourceLabel = useRasterStore((state) => state.sourceLabel);
  const selectFile = useRasterStore((state) => state.selectFile);
  const resetMapUi = useMapUiStore((state) => state.reset);
  const rasterRenderSettings = useMapUiStore((state) => state.rasterRenderSettings);
  const setRasterRenderSettings = useMapUiStore((state) => state.setRasterRenderSettings);
  const metadata = useRasterStore((state) => state.metadata);
  const preview = useRasterStore((state) => state.preview);
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
  const singleBandRange = preview?.sampleRanges?.[0] ?? null;

  return (
    <aside className="panel" aria-label="left-panel">
      <h2>文件信息</h2>
      <div className="card">
        <label className="field-label" htmlFor="raster-file-input">
          选择 TIFF 文件
        </label>
        <input
          id="raster-file-input"
          className="field-input"
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
            selectFile(file);
          }}
        />
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
            <dt className="metric-label">实际尺寸</dt>
            <dd>{formatRasterPhysicalSize(metadata?.boundingBox)}</dd>
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
            disabled={!fence}
            onClick={() => {
              if (!fence) {
                return;
              }

              downloadGeoJson(createFenceGeoJson(fence), 'fence.geojson');
            }}
          >
            导出围栏
          </button>
          <button
            type="button"
            className="toolbar-button toolbar-button--ghost"
            disabled={!gridSummary || gridCells.length === 0}
            onClick={() => {
              if (!gridSummary || gridCells.length === 0) {
                return;
              }

              downloadGeoJson(createGridGeoJson(gridCells, gridSummary), 'grid-preview.geojson');
            }}
          >
            导出网格
          </button>
        </div>
      </div>

      <h3>值渲染</h3>
      <div className="card">
        <label className="field-label" htmlFor="raster-render-min">
          渲染最小值
        </label>
        <input
          id="raster-render-min"
          aria-label="渲染最小值"
          className="field-input"
          type="number"
          step="0.1"
          placeholder={singleBandRange ? singleBandRange.min.toFixed(2) : '自动'}
          value={rasterRenderSettings.min ?? ''}
          onChange={(event) => {
            const nextValue = event.target.value;
            if (nextValue === '') {
              setRasterRenderSettings({
                min: null,
              });
              return;
            }

            const parsedValue = Number(nextValue);
            if (!Number.isFinite(parsedValue)) {
              return;
            }

            setRasterRenderSettings({
              min: parsedValue,
            });
          }}
        />
        <label className="field-label field-label--stacked" htmlFor="raster-render-max">
          渲染最大值
        </label>
        <input
          id="raster-render-max"
          aria-label="渲染最大值"
          className="field-input"
          type="number"
          step="0.1"
          placeholder={singleBandRange ? singleBandRange.max.toFixed(2) : '自动'}
          value={rasterRenderSettings.max ?? ''}
          onChange={(event) => {
            const nextValue = event.target.value;
            if (nextValue === '') {
              setRasterRenderSettings({
                max: null,
              });
              return;
            }

            const parsedValue = Number(nextValue);
            if (!Number.isFinite(parsedValue)) {
              return;
            }

            setRasterRenderSettings({
              max: parsedValue,
            });
          }}
        />
        <label className="field-label field-label--stacked" htmlFor="raster-render-step">
          分级步长
        </label>
        <input
          id="raster-render-step"
          aria-label="分级步长"
          className="field-input"
          type="number"
          min="0.1"
          step="0.1"
          value={rasterRenderSettings.step}
          onChange={(event) => {
            const nextValue = Number(event.target.value);
            if (Number.isFinite(nextValue) && nextValue > 0) {
              setRasterRenderSettings({
                step: nextValue,
              });
            }
          }}
        />
        <p className="toolbar-hint">
          {singleBandRange
            ? `当前有效值约 ${singleBandRange.min.toFixed(2)} ~ ${singleBandRange.max.toFixed(2)}，留空则按自动范围走。`
            : '单波段影像会按分级灰阶着色，多波段继续按原始预览显示。'}
        </p>
      </div>
    </aside>
  );
}
