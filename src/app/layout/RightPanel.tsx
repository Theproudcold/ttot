import { useState, useEffect } from 'react';
import { getDegreeToMeterScale } from '@/shared/geo/crs';

function DebouncedColorPicker({
  value,
  onChange,
  className
}: {
  value: string;
  onChange: (val: string) => void;
  className?: string;
}) {
  const [localColor, setLocalColor] = useState(value);

  useEffect(() => {
    setLocalColor(value);
  }, [value]);

  useEffect(() => {
    const handler = setTimeout(() => {
      if (localColor !== value) {
        onChange(localColor);
      }
    }, 300);
    return () => clearTimeout(handler);
  }, [localColor, value, onChange]);

  return (
    <input
      type="color"
      className={className}
      value={localColor}
      onChange={(e) => setLocalColor(e.target.value)}
    />
  );
}

function RuleNumberInput({
  value,
  onChange,
  className,
  placeholder,
  step
}: {
  value: number | null | undefined;
  onChange: (val: number | null) => void;
  className?: string;
  placeholder?: string;
  step?: string;
}) {
  const [localValue, setLocalValue] = useState(value == null ? '' : String(value));

  useEffect(() => {
    if (value == null) {
      if (localValue !== '') setLocalValue('');
      return;
    }
    const currentParsed = Number(localValue);
    // 只在外部赋的值真正改变时才同步更新本地输入内容，保护用户输入中的小数点或者尾留0
    if (!Number.isFinite(currentParsed) || currentParsed !== value) {
      setLocalValue(String(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      type="number"
      className={className}
      placeholder={placeholder}
      step={step}
      value={localValue}
      onChange={(e) => {
        setLocalValue(e.target.value);
        if (e.target.value === '') {
          onChange(null);
          return;
        }
        const nextValue = Number(e.target.value);
        if (Number.isFinite(nextValue)) {
          onChange(nextValue);
        }
      }}
    />
  );
}
import { useFenceStore } from '@/features/fence/fenceStore';
import { useGridStore } from '@/features/grid/gridStore';
import { useMapUiStore } from '@/features/map/mapUiStore';
import { useRasterStore } from '@/features/map/rasterStore';
import type { RasterClassificationMode, RasterMetadata, RasterRuleClassificationLayer } from '@/shared/types/raster';

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

function formatGridRatio(
  cellSize: number,
  metadata: RasterMetadata | null | undefined,
): string {
  if (!metadata || cellSize <= 0) {
    return '--';
  }

  const width = metadata.metricWidth;
  const height = metadata.metricHeight;

  if (width <= 0 || height <= 0) {
    return '--';
  }

  const widthRatio = (cellSize / width) * 100;
  const heightRatio = (cellSize / height) * 100;
  return `${widthRatio.toFixed(1)}% / ${heightRatio.toFixed(1)}%`;
}

function formatFenceArea(
  area: number | null,
  bbox: [number, number, number, number] | null | undefined,
  isGeographic: boolean,
): string {
  if (area === null) {
    return '--';
  }
  
  if (isGeographic && bbox) {
    const scale = getDegreeToMeterScale((bbox[1] + bbox[3]) / 2);
    return `${(area * scale.scaleX * scale.scaleY).toFixed(2)} m²`;
  }

  return `${area.toFixed(2)} m²`;
}

function formatFenceBbox(bbox: [number, number, number, number] | null): string {
  if (!bbox) {
    return '--';
  }

  return bbox.map((value) => value.toFixed(2)).join(', ');
}

function formatMetricNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return '--';
  }

  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: 2,
  }).format(value);
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
        applicationRate: null,
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

export function RightPanel() {
  const metadata = useRasterStore((state) => state.metadata);
  const status = useRasterStore((state) => state.status);
  const layers = useMapUiStore((state) => state.layers);
  const hoverInfo = useMapUiStore((state) => state.hoverInfo);
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

  return (
    <aside className="panel" aria-label="right-panel">
      <h2>当前结果</h2>
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
            <dt className="metric-label">预计网格数</dt>
            <dd>{gridSummary?.totalCells ?? '--'}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">命中网格数</dt>
            <dd>{gridSummary?.previewCellCount ?? '--'}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">影像状态</dt>
            <dd>{status}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">围栏范围</dt>
            <dd>{formatFenceBbox(fence?.summary.bbox ?? null)}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">参考范围</dt>
            <dd>{formatSourceExtent(metadata)}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">影像实际尺寸</dt>
            <dd>{formatRasterPhysicalSize(metadata)}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">网格比例</dt>
            <dd>{formatGridRatio(cellSize, metadata)}</dd>
          </div>
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
        {hoverInfo ? (
          <dl className="metric-list">
            <div className="metric-item">
              <dt className="metric-label">坐标</dt>
              <dd>{hoverInfo.coordinate.map((value) => value.toFixed(getCoordinateDecimals(metadata))).join(', ')}</dd>
            </div>
            <div className="metric-item">
              <dt className="metric-label">像元位置</dt>
              <dd>{`${hoverInfo.pixel.row} / ${hoverInfo.pixel.col}`}</dd>
            </div>
            <div className="metric-item">
              <dt className="metric-label">像元值</dt>
              <dd>
                {hoverInfo.sampleValues
                  ? hoverInfo.sampleValues.map((value) => value.toFixed(2)).join(' / ')
                  : '--'}
              </dd>
            </div>
            <div className="metric-item">
              <dt className="metric-label">分类方案</dt>
              <dd>{hoverInfo.classificationLayerName ?? '--'}</dd>
            </div>
            <div className="metric-item">
              <dt className="metric-label">分级区间</dt>
              <dd>{hoverInfo.classificationLabel ?? '--'}</dd>
            </div>
            <div className="metric-item">
              <dt className="metric-label">分级颜色</dt>
              <dd className="metric-color-value">
                {hoverInfo.classificationColor ? (
                  <>
                    <span
                      aria-label="像元分级颜色"
                      className="color-chip"
                      style={{ backgroundColor: hoverInfo.classificationColor }}
                    />
                    {hoverInfo.classificationColor}
                  </>
                ) : (
                  '--'
                )}
              </dd>
            </div>
            <div className="metric-item">
              <dt className="metric-label">围栏命中</dt>
              <dd>{hoverInfo.inFence ? '是' : '否'}</dd>
            </div>
            <div className="metric-item">
              <dt className="metric-label">网格命中</dt>
              <dd>{hoverInfo.gridCellId ?? '--'}</dd>
            </div>
            <div className="metric-item">
              <dt className="metric-label">网格均值</dt>
              <dd>{formatMetricNumber(hoverInfo.gridMeanValue)}</dd>
            </div>
            <div className="metric-item">
              <dt className="metric-label">有效像元数</dt>
              <dd>{formatMetricNumber(hoverInfo.gridValidPixelCount)}</dd>
            </div>
          </dl>
        ) : (
          '把鼠标移到地图上，右侧会显示当前坐标、像元和值。'
        )}
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
                    当前为渐变方案骨架，暂不支持在 UI 更改停靠点。
                  </p>
                </>
              ) : (
                <div className="classification-rules">
                  {activeClassificationLayer.rules.map((rule, index) => {
                    let matchedCount = 0;
                    if (gridCells && gridCells.length > 0) {
                      for (const cell of gridCells) {
                        const val = cell.aggregation?.meanValue;
                        if (val == null) continue;
                        if (val >= rule.min && (rule.max === null || val <= rule.max)) {
                          matchedCount++;
                        }
                      }
                    }
                    const areaM2 = matchedCount * cellAreaM2;
                    const totalAmount = rule.applicationRate ? rule.applicationRate * matchedCount : 0;

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
                            <span className="field-label" style={{ fontSize: '10px' }}>单格用药重量</span>
                            <RuleNumberInput
                              className="field-input"
                              step="0.01"
                              placeholder="例如: 0.5"
                              value={rule.applicationRate}
                              onChange={(nextValue) => {
                                updateRuleField(index, 'applicationRate', nextValue);
                              }}
                            />
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
                            <input
                              className="field-input"
                              type="text"
                              value={rule.label}
                              onChange={(event) => {
                                updateRuleField(index, 'label', event.target.value);
                              }}
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
                              <span style={{ color: '#666' }}>预计用药重量：</span>
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
                      updateClassificationLayer(activeClassificationLayer.id, {
                        rules: [
                          ...activeClassificationLayer.rules,
                          { min: 0, max: null, color: '#ff0000', label: `规则 ${activeClassificationLayer.rules.length + 1}`, applicationRate: null }
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
