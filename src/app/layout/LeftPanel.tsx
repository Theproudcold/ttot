import {
  createFenceGeoJson,
  createGridGeoJson,
  downloadGeoJson,
} from '@/features/export/exportGeoJson';
import { useFenceStore } from '@/features/fence/fenceStore';
import { useGridStore } from '@/features/grid/gridStore';
import { useMapUiStore } from '@/features/map/mapUiStore';
import { useRasterStore } from '@/features/map/rasterStore';
import type { RasterClassificationMode, RasterRuleClassificationLayer } from '@/shared/types/raster';

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

function formatClassificationMode(mode: RasterClassificationMode): string {
  return mode === 'gradient' ? '渐变' : '规则';
}

function createClassificationLayerId(existingIds: string[]): string {
  let index = 1;
  let nextId = `classification-rules-${index}`;

  while (existingIds.includes(nextId)) {
    index += 1;
    nextId = `classification-rules-${index}`;
  }

  return nextId;
}

function createClassificationLayerLabel(existingLabels: string[]): string {
  let index = 1;
  let nextLabel = `自定义方案 ${index}`;

  while (existingLabels.includes(nextLabel)) {
    index += 1;
    nextLabel = `自定义方案 ${index}`;
  }

  return nextLabel;
}

function buildNewRulesClassificationLayer(
  existingIds: string[],
  existingLabels: string[],
): RasterRuleClassificationLayer & { visible: boolean } {
  return {
    id: createClassificationLayerId(existingIds),
    label: createClassificationLayerLabel(existingLabels),
    mode: 'rules',
    noDataColor: '#00000000',
    gradientStops: [],
    rules: [
      {
        min: -1,
        max: 0,
        color: '#cccccc',
        label: '规则 1',
      },
    ],
    visible: true,
  };
}

function updateRuleTuple(
  rules: RasterRuleClassificationLayer['rules'],
  ruleIndex: number,
  updater: (rule: RasterRuleClassificationLayer['rules'][number]) => RasterRuleClassificationLayer['rules'][number],
): RasterRuleClassificationLayer['rules'] {
  const [firstRule, ...restRules] = rules;

  return [
    ruleIndex === 0 ? updater(firstRule) : firstRule,
    ...restRules.map((rule, index) => (index + 1 === ruleIndex ? updater(rule) : rule)),
  ] as RasterRuleClassificationLayer['rules'];
}

export function LeftPanel() {
  const sourceLabel = useRasterStore((state) => state.sourceLabel);
  const selectFile = useRasterStore((state) => state.selectFile);
  const resetMapUi = useMapUiStore((state) => state.reset);
  const classificationLayers = useMapUiStore((state) => state.classificationLayers);
  const activeClassificationLayerId = useMapUiStore((state) => state.activeClassificationLayerId);
  const visibleClassificationLayerId = useMapUiStore((state) => state.visibleClassificationLayerId);
  const addClassificationLayer = useMapUiStore((state) => state.addClassificationLayer);
  const updateClassificationLayer = useMapUiStore((state) => state.updateClassificationLayer);
  const duplicateClassificationLayer = useMapUiStore((state) => state.duplicateClassificationLayer);
  const deleteClassificationLayer = useMapUiStore((state) => state.deleteClassificationLayer);
  const setActiveClassificationLayer = useMapUiStore((state) => state.setActiveClassificationLayer);
  const toggleClassificationLayerVisibility = useMapUiStore(
    (state) => state.toggleClassificationLayerVisibility,
  );
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
  const activeClassificationLayer =
    classificationLayers.find((layer) => layer.id === activeClassificationLayerId) ??
    classificationLayers[0] ??
    null;

  const createClassificationLayer = () => {
    const nextLayer = buildNewRulesClassificationLayer(
      classificationLayers.map((layer) => layer.id),
      classificationLayers.map((layer) => layer.label),
    );

    addClassificationLayer(nextLayer);
    setActiveClassificationLayer(nextLayer.id);
  };

  const updateRuleField = (
    ruleIndex: number,
    field: 'min' | 'max' | 'color' | 'label',
    value: number | string | null,
  ) => {
    if (!activeClassificationLayer || activeClassificationLayer.mode !== 'rules') {
      return;
    }

    const nextRules = updateRuleTuple(activeClassificationLayer.rules, ruleIndex, (rule) => {
      if (field === 'min') {
        return {
          ...rule,
          min: typeof value === 'number' ? value : rule.min,
        };
      }

      if (field === 'max') {
        return {
          ...rule,
          max: typeof value === 'number' || value === null ? value : rule.max,
        };
      }

      if (field === 'color') {
        return {
          ...rule,
          color: typeof value === 'string' ? value : rule.color,
        };
      }

      return {
        ...rule,
        label: typeof value === 'string' ? value : rule.label,
      };
    });

    updateClassificationLayer(activeClassificationLayer.id, {
      rules: nextRules,
    });
  };

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

      <h3>分类方案</h3>
      <div className="card">
        <div className="classification-card__section">
          <div className="classification-card__header">
            <div>
              <p className="classification-card__title">方案列表</p>
              <p className="classification-card__subtitle">切换当前方案，并决定哪些方案处于可见状态。</p>
            </div>
            <button type="button" className="toolbar-button" onClick={createClassificationLayer}>
              新建方案
            </button>
          </div>

          <div className="classification-list" role="list" aria-label="分类方案列表">
            {classificationLayers.map((layer) => {
              const isActive = layer.id === activeClassificationLayer?.id;
              const isVisible = layer.visible;
              const isPrimaryVisible = layer.id === visibleClassificationLayerId;

              return (
                <article
                  key={layer.id}
                  className={`classification-item${isActive ? ' classification-item--active' : ''}`}
                  role="listitem"
                >
                  <div className="classification-item__main">
                    <div>
                      <div className="classification-item__title-row">
                        <strong className="classification-item__title">{layer.label}</strong>
                        <span className="classification-item__tag">{formatClassificationMode(layer.mode)}</span>
                        {isPrimaryVisible ? (
                          <span className="classification-item__status">显示中</span>
                        ) : null}
                      </div>
                      <p className="classification-item__meta">
                        {isActive ? '当前正在编辑' : '点击设为当前以编辑此方案'}
                      </p>
                    </div>
                    <label className="classification-item__toggle">
                      <input
                        type="checkbox"
                        checked={isVisible}
                        onChange={() => {
                          toggleClassificationLayerVisibility(layer.id);
                        }}
                      />
                      <span>可见</span>
                    </label>
                  </div>
                  <div className="classification-item__actions">
                    <button
                      type="button"
                      className="toolbar-button toolbar-button--ghost"
                      onClick={() => {
                        setActiveClassificationLayer(layer.id);
                      }}
                      disabled={isActive}
                    >
                      设为当前
                    </button>
                    <button
                      type="button"
                      className="toolbar-button toolbar-button--ghost"
                      onClick={() => {
                        const duplicatedLayerId = duplicateClassificationLayer(layer.id);
                        if (duplicatedLayerId) {
                          setActiveClassificationLayer(duplicatedLayerId);
                        }
                      }}
                    >
                      复制方案
                    </button>
                    <button
                      type="button"
                      className="toolbar-button toolbar-button--ghost"
                      onClick={() => {
                        deleteClassificationLayer(layer.id);
                      }}
                      disabled={classificationLayers.length <= 1}
                    >
                      删除方案
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </div>

        <div className="classification-card__divider" />

        <div className="classification-card__section">
          <div className="classification-card__header">
            <div>
              <p className="classification-card__title">当前方案编辑器</p>
              <p className="classification-card__subtitle">这里只做最小可用编辑，不抢后面任务的戏。</p>
            </div>
          </div>

          {activeClassificationLayer ? (
            <>
              <label className="field-label" htmlFor="classification-layer-name">
                方案名称
              </label>
              <input
                id="classification-layer-name"
                className="field-input"
                type="text"
                value={activeClassificationLayer.label}
                onChange={(event) => {
                  updateClassificationLayer(activeClassificationLayer.id, {
                    label: event.target.value,
                  });
                }}
              />

              {activeClassificationLayer.mode === 'gradient' ? (
                <>
                  <p className="toolbar-hint">
                    {singleBandRange
                      ? `范围提示：当前采样约 ${singleBandRange.min.toFixed(2)} ~ ${singleBandRange.max.toFixed(2)}。`
                      : '范围提示：暂无采样范围，后续按影像预览数据补充。'}
                  </p>
                  <p className="classification-editor__note">
                    当前为渐变方案骨架，先提供名称和范围提示，别把停靠点编辑器硬塞进来。
                  </p>
                </>
              ) : (
                <div className="classification-rules">
                  {activeClassificationLayer.rules.map((rule, index) => (
                    <div key={`${activeClassificationLayer.id}-rule-${index}`} className="classification-rule">
                      <div className="classification-rule__header">
                        <strong>{`规则 ${index + 1}`}</strong>
                        <span className="classification-item__tag">rules</span>
                      </div>
                      <div className="classification-rule__grid">
                        <input
                          aria-label={`规则最小值-${index}`}
                          className="field-input"
                          type="number"
                          step="0.1"
                          value={rule.min}
                          onChange={(event) => {
                            const nextValue = Number(event.target.value);
                            if (!Number.isFinite(nextValue)) {
                              return;
                            }

                            updateRuleField(index, 'min', nextValue);
                          }}
                        />
                        <input
                          aria-label={`规则最大值-${index}`}
                          className="field-input"
                          type="number"
                          step="0.1"
                          placeholder="无上限"
                          value={rule.max ?? ''}
                          onChange={(event) => {
                            if (event.target.value === '') {
                              updateRuleField(index, 'max', null);
                              return;
                            }

                            const nextValue = Number(event.target.value);
                            if (!Number.isFinite(nextValue)) {
                              return;
                            }

                            updateRuleField(index, 'max', nextValue);
                          }}
                        />
                        <input
                          aria-label={`规则颜色-${index}`}
                          className="field-input classification-rule__color"
                          type="color"
                          value={rule.color}
                          onChange={(event) => {
                            updateRuleField(index, 'color', event.target.value);
                          }}
                        />
                        <input
                          aria-label={`规则标签-${index}`}
                          className="field-input"
                          type="text"
                          value={rule.label}
                          onChange={(event) => {
                            updateRuleField(index, 'label', event.target.value);
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="toolbar-hint">暂无可编辑方案。</p>
          )}
        </div>
      </div>
    </aside>
  );
}
