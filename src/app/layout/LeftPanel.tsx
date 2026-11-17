import { useState, useEffect, useRef } from 'react';
import { useDebounce } from '@/shared/hooks/useDebounce';
import { useDebouncedCallback } from '@/shared/hooks/useDebouncedCallback';

import { useFenceStore } from '@/features/fence/fenceStore';
import { useGridStore } from '@/features/grid/gridStore';
import { useMapUiStore } from '@/features/map/mapUiStore';
import { useRasterStore } from '@/features/map/rasterStore';
import { applyProjectSnapshot } from '@/features/project/applyProjectSnapshot';
import { readProjectSnapshotFromGeoJson } from '@/features/project/geojsonProject';
import { readEmbeddedProjectSnapshot } from '@/features/project/readEmbeddedSnapshot';
import type { ProjectSnapshotV1 } from '@/features/project/projectSnapshot';
import { buildRestorePlan, fingerprintFromFile } from '@/features/project/projectSnapshot';
import { getDegreeToMeterScale, getMinCellSizeFromMetadata } from '@/shared/geo/crs';
import {
  formatGridRatio,
  formatRasterPhysicalSize,
  formatSourceExtent,
} from './right-panel/classificationUtils';
import { parseFenceGeoJson } from '@/shared/geo/geojsonImport';
import { readBlobBuffer } from '@/shared/geo/rasterIo';
import type { RasterMetadata } from '@/shared/types/raster';

function formatCellSize(metadata: RasterMetadata | null | undefined): string {
  if (!metadata) {
    return '--';
  }

  const { x, unit } = metadata.cellSize;
  if (!x) {
    return '--';
  }

  if (unit === 'degree') {
    const latitude = (metadata.boundingBox[1] + metadata.boundingBox[3]) / 2;
    const { scaleX } = getDegreeToMeterScale(latitude);
    const meters = x * scaleX;
    return `${meters.toFixed(4)} m`;
  }

  return `${x.toFixed(4)} ${unit}`;
}

export function LeftPanel() {
  const sourceLabel = useRasterStore((state) => state.sourceLabel);
  const sourceFile = useRasterStore((state) => state.sourceFile);
  const selectFile = useRasterStore((state) => state.selectFile);
  const resetRaster = useRasterStore((state) => state.reset);
  const resetMapUi = useMapUiStore((state) => state.reset);
  const metadata = useRasterStore((state) => state.metadata);
  const loadingProgress = useRasterStore((state) => state.loadingProgress);
  const validityStatus = useRasterStore((state) => state.validityStatus);
  const fence = useFenceStore((state) => state.fence);
  const fenceMode = useFenceStore((state) => state.mode);
  const startDraw = useFenceStore((state) => state.startDraw);
  const startEdit = useFenceStore((state) => state.startEdit);
  const stopInteraction = useFenceStore((state) => state.stopInteraction);
  const clearFence = useFenceStore((state) => state.clearFence);
  const setFence = useFenceStore((state) => state.setFence);
  const resetFence = useFenceStore((state) => state.reset);
  const cellSize = useGridStore((state) => state.cellSize);
  const rotation = useGridStore((state) => state.rotation);
  const aggregationMode = useGridStore((state) => state.aggregationMode);
  const gridSummary = useGridStore((state) => state.summary);
  const setCellSize = useGridStore((state) => state.setCellSize);
  const setRotation = useGridStore((state) => state.setRotation);
  const setAggregationMode = useGridStore((state) => state.setAggregationMode);
  const resetGrid = useGridStore((state) => state.reset);
  const gridRenderSettings = useMapUiStore((state) => state.gridRenderSettings);
  const setGridRenderSettings = useMapUiStore((state) => state.setGridRenderSettings);

  const [localCellSize, setLocalCellSize] = useState(String(cellSize));
  const latestCellSizeInputRef = useRef(String(cellSize));
  const cellSizeRef = useRef(cellSize);
  const [localRotation, setLocalRotation] = useState(String(rotation));
  const debouncedRotation = useDebounce(localRotation, 300);
  /** 只有用户改过输入才回写 store，避免用陈旧的防抖值覆盖外部还原 */
  const rotationEditedRef = useRef(false);

  const [pendingRestore, setPendingRestore] = useState<{
    snapshot: ProjectSnapshotV1;
    label: string;
  } | null>(null);
  const [importNotice, setImportNotice] = useState<string[]>([]);

  /**
   * 选择影像。
   *
   * 刻意**不再**清空围栏/网格/分类方案：清空的后果就是「导入自己导出的文件后一切归零」。
   * 若新影像与既有围栏不匹配，网格聚合会因「围栏超出影像范围」而回退为纯几何预览。
   */
  const handleRasterFile = (file: File) => {
    setImportNotice([]);
    setPendingRestore(null);
    selectFile(file);

    void readEmbeddedProjectSnapshot(file)
      .then((result) => {
        if (!result) {
          return; // 普通影像，没有内嵌配方
        }

        if (result.ok) {
          setPendingRestore({ snapshot: result.snapshot, label: file.name });
        } else {
          setImportNotice(result.errors);
        }
      })
      .catch(() => {
        // 无法解析为 GeoTIFF 时交给既有加载流程报错，这里不重复提示
      });
  };

  const handleGeoJsonFile = async (file: File) => {
    setImportNotice([]);

    // 不用 file.text()：部分环境（含 jsdom）没有实现 Blob.text，统一走既有的 FileReader 封装
    let text: string;
    try {
      text = new TextDecoder().decode(await readBlobBuffer(file));
    } catch {
      setImportNotice(['无法读取文件内容。']);
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      setImportNotice(['文件不是合法的 JSON']);
      return;
    }

    const fenceResult = parseFenceGeoJson(json);
    const projectResult = readProjectSnapshotFromGeoJson(json);
    const notices = [...projectResult.warnings];

    if (!fenceResult.ok) {
      setImportNotice([...notices, ...fenceResult.errors]);
      return;
    }

    notices.push(...fenceResult.warnings);

    if (fenceResult.rings) {
      setFence(fenceResult.rings);
      notices.push(`已导入围栏：${(fenceResult.rings[0]?.length ?? 1) - 1} 个顶点。`);
    }

    if (projectResult.snapshot) {
      setPendingRestore({ snapshot: projectResult.snapshot, label: file.name });
    }

    setImportNotice(notices);
  };

  const confirmRestore = () => {
    if (!pendingRestore) {
      return;
    }

    // 还原前先比对：坐标系不一致会让网格整体偏移，围栏越界则无法聚合
    const raster = useRasterStore.getState();
    const plan = buildRestorePlan({
      snapshot: pendingRestore.snapshot,
      currentFingerprint: raster.sourceFile ? fingerprintFromFile(raster.sourceFile) : null,
      currentCrsCode: raster.metadata?.crsCode ?? null,
      currentBoundingBox: raster.metadata?.boundingBox ?? null,
    });

    if (plan.action === 'blocked') {
      setImportNotice(plan.errors);
      setPendingRestore(null);
      return;
    }

    applyProjectSnapshot(pendingRestore.snapshot);
    setImportNotice(['已还原工程设置。', ...plan.warnings]);
    setPendingRestore(null);
  };

  const minCellSize = getMinCellSizeFromMetadata(metadata);

  const commitCellSize = useDebouncedCallback((nextRawValue: string) => {
    if (nextRawValue !== latestCellSizeInputRef.current) {
      return;
    }

    let nextValue = Number(nextRawValue);
    if (!Number.isFinite(nextValue) || nextValue <= 0) {
      return;
    }

    if (nextValue < minCellSize) {
      nextValue = minCellSize;
      setLocalCellSize(String(nextValue));
      latestCellSizeInputRef.current = String(nextValue);
    }

    if (nextValue !== cellSizeRef.current) {
      setCellSize(nextValue);
    }
  }, 300);

  useEffect(() => {
    const nextCellSize = String(cellSize);
    cellSizeRef.current = cellSize;
    latestCellSizeInputRef.current = nextCellSize;
    setLocalCellSize(nextCellSize);
  }, [cellSize]);

  useEffect(() => {
    rotationEditedRef.current = false;
    setLocalRotation(String(rotation));
  }, [rotation]);

  useEffect(() => {
    // 外部还原 rotation（如恢复工程草稿）时，localRotation 会同步、但防抖值仍是旧值；
    // 若此时无条件回写，就会把刚还原的 rotation 立刻覆盖回旧值。
    if (!rotationEditedRef.current) {
      return;
    }

    const nextValue = Number(debouncedRotation);
    if (!Number.isFinite(nextValue)) {
      return;
    }

    rotationEditedRef.current = false;

    const normalized = ((nextValue % 360) + 360) % 360;
    if (normalized !== rotation) {
      setRotation(normalized);
    }
  }, [debouncedRotation, rotation, setRotation]);

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
                  event.target.value = '';
                  if (!file) {
                    return;
                  }

                  handleRasterFile(file);
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
                }}
              >
                移除
              </button>
            </div>
          )}

          <label
            className="toolbar-button toolbar-button--ghost"
            htmlFor="fence-geojson-input"
            style={{ display: 'inline-block', textAlign: 'center', width: '100%', marginTop: 8 }}
          >
            导入围栏 GeoJSON
          </label>
          <input
            id="fence-geojson-input"
            className="visually-hidden"
            type="file"
            accept=".geojson,.json,application/geo+json,application/json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) {
                return;
              }

              void handleGeoJsonFile(file);
            }}
          />
        </div>

        {pendingRestore ? (
          <div className="alert-toast" role="status" aria-label="project-restore">
            <span className="alert-toast__icon">📄</span>
            <span className="alert-toast__text">
              「{pendingRestore.label}」内含工程设置，是否还原？
            </span>
            <div className="toolbar-row">
              <button type="button" className="toolbar-button" onClick={confirmRestore}>
                还原
              </button>
              <button
                type="button"
                className="toolbar-button toolbar-button--ghost"
                onClick={() => setPendingRestore(null)}
              >
                忽略
              </button>
            </div>
          </div>
        ) : null}

        {importNotice.length > 0 ? (
          <ul
            className="toolbar-hint"
            aria-label="import-notice"
            style={{ margin: '8px 0 0', paddingLeft: 18 }}
          >
            {importNotice.map((notice, index) => (
              <li key={`${notice}-${index}`}>{notice}</li>
            ))}
          </ul>
        ) : null}
        <dl className="metric-list metric-list--two-col">
          <div className="metric-item">
            <dt className="metric-label">文件名</dt>
            <dd className="metric-value" title={metadata?.fileName ?? sourceLabel}>{metadata?.fileName ?? sourceLabel}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">尺寸</dt>
            <dd className="metric-value">{metadata ? `${metadata.width} x ${metadata.height}` : '--'}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">CRS</dt>
            <dd className="metric-value">{metadata?.crsCode ?? '--'}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">像元大小</dt>
            <dd className="metric-value">{formatCellSize(metadata)}</dd>
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
          <div className="metric-item metric-item--full">
            <dt className="metric-label">原始范围</dt>
            <dd className="metric-value">{formatSourceExtent(metadata)}</dd>
          </div>
          <div className="metric-item metric-item--full">
            <dt className="metric-label">实际尺寸</dt>
            <dd className="metric-value">{formatRasterPhysicalSize(metadata)}</dd>
          </div>
        </dl>
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
          min={minCellSize}
          step="0.1"
          value={localCellSize}
          onChange={(event) => {
            const nextRawValue = event.target.value;
            latestCellSizeInputRef.current = nextRawValue;
            setLocalCellSize(nextRawValue);

            if (nextRawValue === '') {
              return;
            }

            commitCellSize(nextRawValue);
          }}
        />
        {metadata && (
          <p style={{ margin: '4px 0 0', fontSize: 12, color: '#6b7280' }}>
            {`最小网格尺寸受影像分辨率限制为 ${minCellSize.toFixed(4)} 米`}
          </p>
        )}
        <label className="field-label" htmlFor="grid-aggregation-mode" style={{ marginTop: 12, display: 'block' }}>
          聚合方式
        </label>
        <select
          id="grid-aggregation-mode"
          className="field-input"
          value={aggregationMode}
          onChange={(event) => setAggregationMode(event.target.value as typeof aggregationMode)}
          style={{ width: '100%' }}
        >
          <option value="mean">均值</option>
          <option value="max">最大值</option>
          <option value="min">最小值</option>
        </select>
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
          onChange={(event) => {
            rotationEditedRef.current = true;
            setLocalRotation(event.target.value);
          }}
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
          <div className="grid-render-custom" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 12px' }}>
            {!gridRenderSettings.useClassificationColors && (
              <>
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
              </>
            )}
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
        </div>
      </div>
    </aside>
  );
}
