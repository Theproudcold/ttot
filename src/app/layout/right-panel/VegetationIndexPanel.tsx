/**
 * 植被指数面板。
 *
 * 把已完成的算法层接出界面：读取各波段采样 → 识别波段角色（可手工覆盖）
 * → 计算指数 → 等面积分级 → 生成一个可直接用于导出与地图着色的分类方案。
 *
 * 安全设计：波段识别结果只作**初始值**。低置信度的推测（厂商顺序、反射率启发式）
 * 必须由用户确认——认反 NIR/Red 会让 NDVI 整体变号，处方图"看起来正常但完全相反"。
 */

import { useEffect, useMemo, useState } from 'react';

import { useMapUiStore } from '@/features/map/mapUiStore';
import { useRasterStore } from '@/features/map/rasterStore';
import {
  SPECTRAL_BAND_ROLE_ORDER,
  buildBandHints,
  identifySpectralBands,
  resolveUsableIndices,
  type BandIdentificationResult,
  type BandRoleAssignment,
} from '@/shared/geo/bandIdentification';
import { DEFAULT_EQUAL_AREA_CLASS_COUNT } from '@/shared/geo/classificationHistogram';
import {
  buildBandSampleCacheKey,
  computeBandMeans,
  loadRasterBandSamples,
  type RasterBandSamples,
} from '@/shared/geo/rasterBands';
import {
  SPECTRAL_BAND_ROLE_LABELS,
  VEGETATION_INDEX_DEFINITIONS,
  VEGETATION_INDEX_IDS,
  type SpectralBandRole,
  type VegetationIndexId,
} from '@/shared/geo/vegetationIndex';
import {
  prepareCustomIndexLayer,
  prepareVegetationIndexLayer,
  resolveRoleBands,
} from '@/shared/geo/vegetationIndexLayer';

type GeneratedSummary = {
  layerLabel: string;
  validCount: number;
  range: { min: number; max: number } | null;
  breaks: number[];
  bins: Array<{ from: number; to: number; count: number }>;
  classes: Array<{ label: string; min: number; max: number | null; count: number; color: string }>;
};

const CONFIDENCE_LABELS: Record<BandIdentificationResult['confidence'], string> = {
  high: '高',
  medium: '中',
  low: '低',
};

const METHOD_LABELS: Record<BandIdentificationResult['method'], string> = {
  wavelength: '波长元数据',
  'band-name': '波段名称',
  convention: '厂商波段顺序',
  'reflectance-heuristic': '反射率推测',
  none: '无法识别',
};

export function VegetationIndexPanel() {
  const sourceFile = useRasterStore((state) => state.sourceFile);
  const metadata = useRasterStore((state) => state.metadata);
  const addClassificationLayer = useMapUiStore((state) => state.addClassificationLayer);
  const setActiveClassificationLayer = useMapUiStore((state) => state.setActiveClassificationLayer);
  const setVisibleClassificationLayer = useMapUiStore((state) => state.setVisibleClassificationLayer);

  const [samples, setSamples] = useState<RasterBandSamples | null>(null);
  const [identification, setIdentification] = useState<BandIdentificationResult | null>(null);
  const [assignment, setAssignment] = useState<BandRoleAssignment>({});
  const [indexId, setIndexId] = useState<VegetationIndexId>('ndvi');
  const [customMode, setCustomMode] = useState(false);
  const [formula, setFormula] = useState('(nir - red) / (nir + red)');
  const [classCount, setClassCount] = useState(String(DEFAULT_EQUAL_AREA_CLASS_COUNT));
  const [messages, setMessages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [generated, setGenerated] = useState<GeneratedSummary | null>(null);

  useEffect(() => {
    if (!sourceFile) {
      setSamples(null);
      setIdentification(null);
      setAssignment({});
      setGenerated(null);
      return;
    }

    let disposed = false;
    setBusy(true);
    setMessages([]);
    setGenerated(null);

    void loadRasterBandSamples(sourceFile, { cacheKey: buildBandSampleCacheKey(sourceFile) })
      .then((loaded) => {
        if (disposed) {
          return;
        }

        const hints = buildBandHints({
          sampleCount: loaded.sampleCount,
          metadataByBand: loaded.metadataByBand,
          bandMeans: computeBandMeans(loaded.bands),
        });
        const result = identifySpectralBands({ sampleCount: loaded.sampleCount, hints });

        setSamples(loaded);
        setIdentification(result);
        setAssignment(result.assignment);
        setMessages(result.reasons);
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setMessages([`读取波段数据失败：${error instanceof Error ? error.message : '未知错误'}`]);
        }
      })
      .finally(() => {
        if (!disposed) {
          setBusy(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [sourceFile, metadata]);

  const usableIndices = useMemo(() => resolveUsableIndices(assignment), [assignment]);

  useEffect(() => {
    if (customMode) {
      return;
    }

    if (usableIndices.length > 0 && !usableIndices.includes(indexId)) {
      setIndexId(usableIndices[0]);
    }
  }, [customMode, indexId, usableIndices]);

  const bandOptions = useMemo(
    () => Array.from({ length: samples?.sampleCount ?? 0 }, (_, index) => index),
    [samples],
  );

  const updateRoleBand = (role: SpectralBandRole, rawValue: string) => {
    setAssignment((previous) => {
      const next: BandRoleAssignment = { ...previous };

      if (rawValue === '') {
        delete next[role];
      } else {
        next[role] = Number(rawValue);
      }

      return next;
    });
  };

  const handleGenerate = () => {
    if (!samples) {
      return;
    }

    setMessages([]);

    const requestedClasses = Number(classCount);
    const safeClassCount =
      Number.isFinite(requestedClasses) && requestedClasses >= 2
        ? Math.floor(requestedClasses)
        : DEFAULT_EQUAL_AREA_CLASS_COUNT;
    const roles = resolveRoleBands({ bandArrays: samples.bands, assignment });

    try {
      const plan = customMode
        ? prepareCustomIndexLayer({
            source: formula,
            width: samples.width,
            height: samples.height,
            bands: roles,
            noDataValue: samples.noDataValue,
            classCount: safeClassCount,
            layerId: `custom-index-${Date.now()}`,
          })
        : prepareVegetationIndexLayer({
            index: indexId,
            width: samples.width,
            height: samples.height,
            bands: roles,
            noDataValue: samples.noDataValue,
            classCount: safeClassCount,
            layerId: `index-${indexId}-${Date.now()}`,
          });

      if (!plan) {
        setMessages(['当前数据无法分级：可能全部为无值，或取值过于集中无法切分。']);
        return;
      }

      addClassificationLayer(plan.layer);
      setActiveClassificationLayer(plan.layer.id);
      setVisibleClassificationLayer(plan.layer.id);

      setGenerated({
        layerLabel: plan.layer.label,
        validCount: plan.classification.totalValidCount,
        range: plan.raster.range,
        breaks: plan.classification.breaks,
        bins: plan.classification.histogram.bins,
        classes: plan.classification.rules.map((rule, index) => ({
          label: rule.label,
          min: rule.min,
          max: rule.max,
          count: plan.classification.counts[index] ?? 0,
          color: rule.color,
        })),
      });

      setMessages([
        `已生成「${plan.layer.label}」，共 ${plan.classification.classCount} 级，${plan.classification.totalValidCount} 个有效采样点。`,
      ]);
    } catch (error) {
      setMessages([error instanceof Error ? error.message : '生成失败']);
    }
  };

  if (!sourceFile) {
    return <p className="toolbar-hint">请先载入影像，再计算植被指数。</p>;
  }

  if (busy) {
    return <p className="toolbar-hint">正在读取各波段采样…</p>;
  }

  if (!samples || !identification) {
    return <p className="toolbar-hint">{messages[0] ?? '暂无可用波段数据。'}</p>;
  }

  if (samples.sampleCount < 2) {
    return (
      <p className="toolbar-hint">
        当前影像是单波段，无法计算植被指数（NDVI 等需要同时具备近红外与红光等波段）。
      </p>
    );
  }

  const maxBinCount = generated
    ? Math.max(1, ...generated.bins.map((bin) => bin.count))
    : 1;

  return (
    <div className="classification-card__section">
      <div className="field-row" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <input
          id="vegetation-index-custom-mode"
          type="checkbox"
          checked={customMode}
          onChange={(event) => setCustomMode(event.target.checked)}
        />
        <label htmlFor="vegetation-index-custom-mode" style={{ fontSize: 14 }}>
          使用自定义公式
        </label>
      </div>

      {customMode ? (
        <>
          <label className="field-label" htmlFor="vegetation-index-formula">
            公式（可用波段：{SPECTRAL_BAND_ROLE_ORDER.map((role) => role).join(' / ')}）
          </label>
          <input
            id="vegetation-index-formula"
            className="field-input"
            type="text"
            value={formula}
            onChange={(event) => setFormula(event.target.value)}
          />
          <p className="toolbar-hint">仅支持数字、波段名、+ - * / ^ 与括号；不使用 eval。</p>
        </>
      ) : (
        <>
          <label className="field-label" htmlFor="vegetation-index-select">
            指数
          </label>
          <select
            id="vegetation-index-select"
            className="field-input"
            value={indexId}
            onChange={(event) => setIndexId(event.target.value as VegetationIndexId)}
          >
            {VEGETATION_INDEX_IDS.map((id) => (
              <option key={id} value={id} disabled={!usableIndices.includes(id)}>
                {VEGETATION_INDEX_DEFINITIONS[id].label}
                {usableIndices.includes(id) ? '' : '（缺波段）'}
              </option>
            ))}
          </select>
          <p className="toolbar-hint">{VEGETATION_INDEX_DEFINITIONS[indexId].formula}</p>
        </>
      )}

      <p className="field-label" style={{ marginTop: 12 }}>
        波段分配（识别依据：{METHOD_LABELS[identification.method]}，置信度：
        {CONFIDENCE_LABELS[identification.confidence]}）
      </p>

      {identification.requiresConfirmation ? (
        <p className="toolbar-hint" style={{ color: '#d35400' }}>
          该结果是推测值，请确认波段对应关系后再生成方案。
        </p>
      ) : null}

      {SPECTRAL_BAND_ROLE_ORDER.map((role) => (
        <div key={role} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <span className="field-label" style={{ width: 64, fontSize: 12 }}>
            {SPECTRAL_BAND_ROLE_LABELS[role]}
          </span>
          <select
            className="field-input"
            aria-label={`${SPECTRAL_BAND_ROLE_LABELS[role]}波段`}
            value={assignment[role] === undefined ? '' : String(assignment[role])}
            onChange={(event) => updateRoleBand(role, event.target.value)}
          >
            <option value="">未指定</option>
            {bandOptions.map((bandIndex) => (
              <option key={bandIndex} value={bandIndex}>
                波段 {bandIndex + 1}
              </option>
            ))}
          </select>
        </div>
      ))}

      <label className="field-label" htmlFor="vegetation-index-class-count" style={{ marginTop: 12, display: 'block' }}>
        分级数量
      </label>
      <input
        id="vegetation-index-class-count"
        className="field-input"
        type="number"
        min={2}
        max={12}
        step={1}
        value={classCount}
        onChange={(event) => setClassCount(event.target.value)}
      />

      <button
        type="button"
        className="toolbar-button"
        style={{ marginTop: 12, width: '100%' }}
        onClick={handleGenerate}
      >
        生成分类方案
      </button>

      {messages.length > 0 ? (
        <ul className="toolbar-hint" aria-label="vegetation-index-message" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          {messages.map((message, index) => (
            <li key={`${message}-${index}`}>{message}</li>
          ))}
        </ul>
      ) : null}

      {generated ? (
        <div aria-label="vegetation-index-result" style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 48 }}>
            {generated.bins.map((bin, index) => (
              <div
                key={`${bin.from}-${index}`}
                title={`${bin.from.toFixed(3)} – ${bin.to.toFixed(3)}：${bin.count}`}
                style={{
                  flex: 1,
                  height: `${Math.round((bin.count / maxBinCount) * 100)}%`,
                  minHeight: bin.count > 0 ? 1 : 0,
                  background: '#3b82f6',
                }}
              />
            ))}
          </div>
          <p className="toolbar-hint" style={{ marginTop: 4 }}>
            分布范围：
            {generated.range ? `${generated.range.min.toFixed(3)} ~ ${generated.range.max.toFixed(3)}` : '--'}
            （{generated.validCount} 个有效采样点）
          </p>
          <div className="classification-list" role="list">
            {generated.classes.map((item) => (
              <div
                key={item.label}
                className="classification-item"
                style={{ padding: '4px 0', display: 'flex', alignItems: 'center', gap: 8 }}
              >
                <span className="color-chip" style={{ backgroundColor: item.color }} />
                <span style={{ flex: 1, fontSize: 12 }}>
                  {item.label}：{item.min.toFixed(3)} ~ {item.max === null ? '∞' : item.max.toFixed(3)}
                </span>
                <span style={{ fontSize: 12, color: '#6b7280' }}>{item.count} 点</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
