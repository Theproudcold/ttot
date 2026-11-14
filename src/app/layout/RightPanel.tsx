import { useMemo } from 'react';

import { useFenceStore } from '@/features/fence/fenceStore';
import { useGridStore } from '@/features/grid/gridStore';
import { useMapUiStore } from '@/features/map/mapUiStore';
import { useRasterStore } from '@/features/map/rasterStore';
import { summarizeApplicationRates } from '@/shared/geo/applicationRate';
import { PREVIEW_RULE_SEMANTICS, findRuleMatch } from '@/shared/geo/classificationRuleMatching';
import type { RasterRuleClassificationLayer } from '@/shared/types/raster';

import {
  APPLICATION_RATE_MODE_OPTIONS,
  buildNewRulesClassificationLayer,
  describeApplicationRateMode,
  formatAreaWithMu,
  formatCellAmount,
  formatClassificationMode,
  formatFenceArea,
  formatFenceBbox,
  formatGridRatio,
  formatMetricNumber,
  resolveApplicationRateMode,
  updateRuleTuple,
  withApplicationRateMode,
  type ApplicationRateMode,
} from './right-panel/classificationUtils';
import { ClassificationLayerNameInput } from './right-panel/ClassificationLayerNameInput';
import { DebouncedColorPicker } from './right-panel/DebouncedColorPicker';
import { HoverInfoCard } from './right-panel/HoverInfoCard';
import { RuleLabelInput } from './right-panel/RuleLabelInput';
import { RuleNumberInput } from './right-panel/RuleNumberInput';

/**
 * 右侧面板。
 * 展示围栏、网格、图层、悬停信息及分类方案的编辑与控制。
 */
export function RightPanel() {
  const metadata = useRasterStore((state) => state.metadata);
  const status = useRasterStore((state) => state.status);
  const layers = useMapUiStore((state) => state.layers);
  const setLayerVisibility = useMapUiStore((state) => state.setLayerVisibility);
  const fence = useFenceStore((state) => state.fence);
  const cellSize = useGridStore((state) => state.cellSize);
  const gridSummary = useGridStore((state) => state.summary);
  const gridCells = useGridStore((state) => state.cells);

  const isGeographic = metadata?.coordinateDisplayMode === 'geographic';
  const preview = useRasterStore((state) => state.preview);
  const singleBandRange = preview?.sampleRanges?.[0] ?? null;

  const classificationLayers = useMapUiStore((state) => state.classificationLayers);
  const activeClassificationLayerId = useMapUiStore((state) => state.activeClassificationLayerId);
  const visibleClassificationLayerId = useMapUiStore((state) => state.visibleClassificationLayerId);
  const addClassificationLayer = useMapUiStore((state) => state.addClassificationLayer);
  const updateClassificationLayer = useMapUiStore((state) => state.updateClassificationLayer);
  const duplicateClassificationLayer = useMapUiStore((state) => state.duplicateClassificationLayer);
  const deleteClassificationLayer = useMapUiStore((state) => state.deleteClassificationLayer);
  const setActiveClassificationLayer = useMapUiStore((state) => state.setActiveClassificationLayer);
  const setVisibleClassificationLayer = useMapUiStore((state) => state.setVisibleClassificationLayer);
  const toggleClassificationLayerVisibility = useMapUiStore(
    (state) => state.toggleClassificationLayerVisibility,
  );

  const activeClassificationLayer =
    classificationLayers.find((layer) => layer.id === activeClassificationLayerId) ??
    classificationLayers[0] ??
    null;

  function createClassificationLayer() {
    const layer = buildNewRulesClassificationLayer(
      classificationLayers.map((layer) => layer.id),
      classificationLayers.map((layer) => layer.label),
    );
    addClassificationLayer(layer);
    setActiveClassificationLayer(layer.id);
    setVisibleClassificationLayer(layer.id);
  }

  function updateRuleField<K extends keyof RasterRuleClassificationLayer['rules'][number]>(
    ruleIndex: number,
    field: K,
    value: RasterRuleClassificationLayer['rules'][number][K],
  ) {
    if (!activeClassificationLayer || activeClassificationLayer.mode !== 'rules') {
      return;
    }

    updateClassificationLayer(activeClassificationLayer.id, {
      rules: updateRuleTuple(activeClassificationLayer.rules, ruleIndex, (rule) => ({
        ...rule,
        [field]: value,
      })),
    });
  }

  const cellAreaM2 = cellSize > 0 ? cellSize * cellSize : 0;

  function updateRuleMode(ruleIndex: number, mode: ApplicationRateMode) {
    if (!activeClassificationLayer || activeClassificationLayer.mode !== 'rules') {
      return;
    }

    updateClassificationLayer(activeClassificationLayer.id, {
      rules: updateRuleTuple(activeClassificationLayer.rules, ruleIndex, (rule) =>
        withApplicationRateMode(rule, mode),
      ),
    });
  }

  const ruleStats = useMemo(() => {
    if (!activeClassificationLayer || activeClassificationLayer.mode !== 'rules' || gridCells.length === 0) {
      return null;
    }

    const rules = activeClassificationLayer.rules;
    const matchedCounts = new Array(rules.length).fill(0);

    // 与地图着色使用同一判定口径（左闭右开），保证面板上的命中格数与看到的颜色一致
    for (const cell of gridCells) {
      const value = cell.aggregation?.outputValue;
      if (value == null) continue;

      const match = findRuleMatch(rules, value, PREVIEW_RULE_SEMANTICS);
      if (match) {
        matchedCounts[match.index] += 1;
      }
    }

    // 用量统计与导出同源：单位面积速率会按格面积换算成每格用量
    const summary = summarizeApplicationRates({ rules, matchedCounts, cellAreaM2 });

    return {
      perRule: summary.perRule,
      totalArea: summary.totalAreaM2,
      totalFertilizer: summary.totalAmount,
    };
  }, [activeClassificationLayer, gridCells, cellAreaM2]);

  return (
    <aside className="panel" aria-label="right-panel">
      <h2>当前结果</h2>

      <h3>围栏信息</h3>
      <div className="card">
        <dl className="metric-list">
          <div className="metric-item">
            <dt className="metric-label">围栏面积</dt>
            <dd>{formatFenceArea(fence?.summary.area ?? null, fence?.summary.bbox, isGeographic)}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">围栏顶点</dt>
            <dd>{fence?.summary.vertexCount ?? '--'}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">围栏范围</dt>
            <dd>{formatFenceBbox(fence?.summary.bbox ?? null)}</dd>
          </div>
        </dl>
      </div>

      <h3>网格信息</h3>
      <div className="card">
        <dl className="metric-list">
          <div className="metric-item">
            <dt className="metric-label">预计网格</dt>
            <dd>{gridSummary?.totalCells ?? '--'}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">命中网格</dt>
            <dd>{gridSummary?.previewCellCount ?? '--'}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">网格比例</dt>
            <dd>{formatGridRatio(cellSize, metadata)}</dd>
          </div>
          {gridSummary?.warning ? (
            <div className="metric-item" style={{ paddingTop: '4px' }}>
              <span style={{ color: '#d35400', fontSize: '12px', lineHeight: '1.4' }}>
                {gridSummary.warning}
              </span>
            </div>
          ) : null}
          {ruleStats && (
            <>
              {activeClassificationLayer.rules.map((rule, index) => (
                <div key={rule.label || `规则 ${index + 1}`} className="metric-item">
                  <dt className="metric-label">{rule.label || `规则 ${index + 1}`} 用药量</dt>
                  <dd>{formatMetricNumber(ruleStats.perRule[index]?.totalAmount ?? 0)}</dd>
                </div>
              ))}
              <div className="metric-item" style={{ borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: '8px', marginTop: '4px' }}>
                <dt className="metric-label">分类覆盖面积</dt>
                <dd>{formatAreaWithMu(ruleStats.totalArea)}</dd>
              </div>
              <div className="metric-item">
                <dt className="metric-label">预计总用药量</dt>
                <dd style={{ color: '#d35400', fontWeight: 600 }}>{formatMetricNumber(ruleStats.totalFertilizer)}</dd>
              </div>
            </>
          )}
        </dl>
      </div>

      <h3>图层</h3>
      <div className="card">
        <label className="toggle-row">
          <span>影像图层</span>
          <input
            aria-label="切换影像图层"
            type="checkbox"
            className="modern-toggle"
            checked={layers.raster}
            onChange={(event) => setLayerVisibility('raster', event.target.checked)}
          />
        </label>
        <label className="toggle-row">
          <span>围栏图层</span>
          <input
            aria-label="切换围栏图层"
            type="checkbox"
            className="modern-toggle"
            checked={layers.fence}
            onChange={(event) => setLayerVisibility('fence', event.target.checked)}
          />
        </label>
        <label className="toggle-row">
          <span>网格图层</span>
          <input
            aria-label="切换网格图层"
            type="checkbox"
            className="modern-toggle"
            checked={layers.grid}
            onChange={(event) => setLayerVisibility('grid', event.target.checked)}
          />
        </label>
      </div>

      <h3>悬停信息</h3>
      <div className="card">
        <HoverInfoCard />
      </div>

      <h3>分类方案</h3>
      <div className="card">
        <div className="classification-card__section">
          <div className="classification-card__header">
            <div>
              <p className="classification-card__title">方案列表</p>
            </div>
            <button type="button" className="toolbar-button" onClick={createClassificationLayer}>
              新建方案
            </button>
          </div>

          <div className="classification-list" role="list">
            {classificationLayers.map((layer) => {
              const isActive = layer.id === activeClassificationLayer?.id;
              const isVisible = layer.visible;
              const isPrimaryVisible = layer.id === visibleClassificationLayerId;

              return (
                <article
                  key={layer.id}
                  className={`classification-item${isActive ? ' classification-item--active' : ''}`}
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
                    </div>
                    <label className="classification-item__toggle">
                      <input
                        type="checkbox"
                        className="modern-toggle"
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
                      onClick={() => setActiveClassificationLayer(layer.id)}
                      disabled={isActive}
                    >
                      设为当前
                    </button>
                    <button
                      type="button"
                      className="toolbar-button toolbar-button--ghost"
                      onClick={() => setVisibleClassificationLayer(layer.id)}
                      disabled={isPrimaryVisible}
                    >
                      设为显示
                    </button>
                    <button
                      type="button"
                      className="toolbar-button toolbar-button--ghost"
                      onClick={() => {
                        const duplicatedLayerId = duplicateClassificationLayer(layer.id);
                        if (duplicatedLayerId) {
                          setActiveClassificationLayer(duplicatedLayerId);
                          setVisibleClassificationLayer(duplicatedLayerId);
                        }
                      }}
                    >
                      复制方案
                    </button>
                    <button
                      type="button"
                      className="toolbar-button toolbar-button--ghost"
                      onClick={() => deleteClassificationLayer(layer.id)}
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
            </div>
          </div>

          {activeClassificationLayer ? (
            <>
              <label className="field-label" htmlFor="classification-layer-name">
                方案名称
              </label>
              <ClassificationLayerNameInput
                layerId={activeClassificationLayer.id}
                label={activeClassificationLayer.label}
                onChange={updateClassificationLayer}
              />

              {activeClassificationLayer.mode === 'gradient' ? (
                <>
                  <p className="toolbar-hint">
                    {singleBandRange
                      ? `范围提示：当前采样约 ${singleBandRange.min.toFixed(2)} ~ ${singleBandRange.max.toFixed(2)}。`
                      : '范围提示：暂无采样范围，后续按影像预览数据补充。'}
                  </p>
                  <p className="classification-editor__note">
                    当前为渐变方案骨架，暂不支持在 UI 更改停靠点。
                  </p>
                </>
              ) : (
                <div className="classification-rules">
                  {activeClassificationLayer.rules.map((rule, index) => {
                    const matchedCount = ruleStats?.perRule[index]?.matchedCount ?? 0;
                    const areaM2 = ruleStats?.perRule[index]?.areaM2 ?? 0;
                    const totalAmount = ruleStats?.perRule[index]?.totalAmount ?? 0;
                    const cellAmount = ruleStats?.perRule[index]?.cellAmount ?? null;
                    const rateMode = resolveApplicationRateMode(rule);

                    return (
                      <div key={`${activeClassificationLayer.id}-rule-${index}`} className="classification-rule" style={{ marginTop: '16px' }}>
                        <div className="classification-rule__header">
                          <strong>{`规则 ${index + 1}`}</strong>
                          <span className="classification-item__tag">rules</span>
                        </div>
                        <div className="classification-rule__grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '12px', paddingBottom: '12px' }}>
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span className="field-label" style={{ fontSize: '10px' }}>最小值</span>
                            <RuleNumberInput
                              className="field-input"
                              step="0.01"
                              value={rule.min}
                              onChange={(nextValue) => {
                                if (nextValue !== null) {
                                  updateRuleField(index, 'min', nextValue);
                                }
                              }}
                            />
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span className="field-label" style={{ fontSize: '10px' }}>最大值 (留空无上限)</span>
                            <RuleNumberInput
                              className="field-input"
                              step="0.01"
                              placeholder="无上限"
                              value={rule.max}
                              onChange={(nextValue) => {
                                updateRuleField(index, 'max', nextValue);
                              }}
                            />
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span className="field-label" style={{ fontSize: '10px' }}>
                              {describeApplicationRateMode(rateMode)}
                            </span>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <RuleNumberInput
                                className="field-input"
                                step="0.01"
                                placeholder="例如: 200"
                                value={rule.applicationRate}
                                onChange={(nextValue) => {
                                  updateRuleField(index, 'applicationRate', nextValue);
                                }}
                              />
                              <select
                                className="field-input"
                                aria-label={`规则 ${index + 1} 计量方式`}
                                style={{ width: 100 }}
                                value={rateMode}
                                onChange={(event) => {
                                  updateRuleMode(index, event.target.value as ApplicationRateMode);
                                }}
                              >
                                {APPLICATION_RATE_MODE_OPTIONS.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                            {rateMode === 'per-cell' ? (
                              <span style={{ fontSize: 11, color: '#6b7280', marginTop: 4, lineHeight: 1.4 }}>
                                该值随网格尺寸变化，建议改用单位面积用量
                              </span>
                            ) : (
                              <span style={{ fontSize: 11, color: '#6b7280', marginTop: 4, lineHeight: 1.4 }}>
                                {cellAmount === null
                                  ? '按当前网格换算后无有效用量'
                                  : `≈ 每格 ${formatCellAmount(cellAmount)}（按 ${cellSize}m 网格）`}
                              </span>
                            )}
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span className="field-label" style={{ fontSize: '10px' }}>规则颜色</span>
                            <DebouncedColorPicker
                              className="field-input classification-rule__color"
                              value={rule.color}
                              onChange={(newColor) => {
                                updateRuleField(index, 'color', newColor);
                              }}
                            />
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gridColumn: '1 / -1' }}>
                            <span className="field-label" style={{ fontSize: '10px' }}>规则标签</span>
                            <RuleLabelInput
                              ruleIndex={index}
                              label={rule.label}
                              onChange={updateRuleField}
                            />
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gridColumn: '1 / -1', background: '#f5f5f5', padding: '8px', borderRadius: '4px', fontSize: '12px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                              <span style={{ color: '#666' }}>命中网格：</span>
                              <strong>{matchedCount} 格</strong>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                              <span style={{ color: '#666' }}>覆盖面积：</span>
                              <strong>{formatMetricNumber(areaM2)} m²</strong>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                              <span style={{ color: '#666' }}>该规则用药量：</span>
                              <strong style={{ color: '#ff6b00' }}>{formatMetricNumber(totalAmount)}</strong>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    className="toolbar-button"
                    style={{ marginTop: '8px', width: '100%' }}
                    onClick={() => {
                      const lastRule = activeClassificationLayer.rules[activeClassificationLayer.rules.length - 1];
                      updateClassificationLayer(activeClassificationLayer.id, {
                        rules: [
                          ...activeClassificationLayer.rules,
                          { min: lastRule?.max ?? 0, max: null, color: '#ff0000', label: `规则 ${activeClassificationLayer.rules.length + 1}`, applicationRate: null }
                        ] as RasterRuleClassificationLayer['rules']
                      });
                    }}
                  >
                    添加规则
                  </button>
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
