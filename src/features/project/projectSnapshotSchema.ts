/**
 * 工程配方的**校验与解析**层。
 *
 * 从 `projectSnapshot.ts` 拆出：契约（类型 + 序列化）与防御性校验的关注点不同，
 * 演进节奏也不同 —— 契约随功能变化，校验随「陌生/损坏文件」的边界情况增长。
 * 本模块只依赖契约类型，无副作用。
 *
 * 校验策略：能修的就地修复并返回 warning，结构性错误返回 error，
 * 保证陌生/损坏文件不会让应用崩溃。
 */

import type { FenceRings } from '@/shared/types/fence';
import type { GridAggregationMode } from '@/shared/types/grid';
import { isApplicationRateBasis, isApplicationRateUnit } from '@/shared/geo/applicationRate';
import type {
  RasterClassificationRule,
  RasterGradientStop,
} from '@/shared/types/raster';

import {
  EMBEDDED_SNAPSHOT_PREFIX,
  PROJECT_SNAPSHOT_KIND,
  PROJECT_SNAPSHOT_VERSION,
  type ClassificationLayerState,
  type LayerKey,
  type ProjectSnapshotDerived,
  type ProjectSnapshotGrid,
  type ProjectSnapshotSource,
  type ProjectSnapshotV1,
  type ProjectSnapshotView,
  type SnapshotParseResult,
} from './projectSnapshot';
import { normalizeRotation } from './rotation';

const MAX_RINGS = 1_000;
const MAX_FENCE_POSITIONS = 200_000;
const MAX_CLASSIFICATION_LAYERS = 200;
const MAX_RULES = 500;
const MAX_GRADIENT_STOPS = 500;
/** 边框宽度上限：仅为拦住损坏文件里的极端值，不影响正常 1~5px 的取值 */
const MAX_STROKE_WIDTH = 100;

const HEX_COLOR_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const DEFAULT_RULE_COLOR = '#cccccc';
const DEFAULT_NO_DATA_COLOR = '#00000000';
function fromBase64(encoded: string): string {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPosition(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) && value.length >= 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1])
  );
}

function parseRings(value: unknown, warnings: string[]): FenceRings | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RINGS) {
    warnings.push('围栏数据无效，已忽略围栏。');
    return null;
  }

  const rings: FenceRings = [];
  let positionCount = 0;

  for (const ring of value) {
    if (!Array.isArray(ring)) {
      warnings.push('围栏数据无效，已忽略围栏。');
      return null;
    }

    const positions: [number, number][] = [];

    for (const position of ring) {
      if (!isPosition(position)) {
        warnings.push('围栏坐标包含非法数值，已忽略围栏。');
        return null;
      }

      positions.push([position[0], position[1]]);
      positionCount += 1;

      if (positionCount > MAX_FENCE_POSITIONS) {
        warnings.push('围栏坐标点过多，已忽略围栏。');
        return null;
      }
    }

    rings.push(positions);
  }

  const outerRing = rings[0] ?? [];
  if (outerRing.length < 4) {
    warnings.push('围栏外环点数不足，已忽略围栏。');
    return null;
  }

  return rings;
}

function parseColor(value: unknown, fallback: string, warnings: string[], what: string): string {
  if (typeof value === 'string' && HEX_COLOR_PATTERN.test(value.trim())) {
    return value.trim();
  }

  warnings.push(`${what}颜色非法，已回退为 ${fallback}。`);
  return fallback;
}

function parseRule(value: unknown, warnings: string[]): RasterClassificationRule | null {
  if (!isRecord(value) || !isFiniteNumber(value.min)) {
    warnings.push('存在非法的分类规则，已丢弃。');
    return null;
  }

  const max = value.max === null || value.max === undefined
    ? null
    : isFiniteNumber(value.max)
      ? value.max
      : undefined;

  if (max === undefined) {
    warnings.push('分类规则的最大值非法，已丢弃该规则。');
    return null;
  }

  const applicationRate =
    value.applicationRate === null || value.applicationRate === undefined
      ? null
      : isFiniteNumber(value.applicationRate)
        ? value.applicationRate
        : null;

  const rule: RasterClassificationRule = {
    min: value.min,
    max,
    color: parseColor(value.color, DEFAULT_RULE_COLOR, warnings, '分类规则'),
    label: typeof value.label === 'string' ? value.label : '',
    applicationRate,
  };

  // 用量基准与单位只在存在合法值时保留，避免给每条规则都塞上默认值污染往返结果
  if (isApplicationRateBasis(value.applicationRateBasis)) {
    rule.applicationRateBasis = value.applicationRateBasis;
  } else if (value.applicationRateBasis !== undefined) {
    warnings.push('分类规则的用量基准非法，已按单格用量处理。');
  }

  if (isApplicationRateUnit(value.applicationRateUnit)) {
    rule.applicationRateUnit = value.applicationRateUnit;
  } else if (value.applicationRateUnit !== undefined) {
    warnings.push('分类规则的用量单位非法，已按每公顷处理。');
  }

  return rule;
}

function parseGradientStop(value: unknown, warnings: string[]): RasterGradientStop | null {
  if (!isRecord(value) || !isFiniteNumber(value.value)) {
    return null;
  }

  return {
    value: value.value,
    color: parseColor(value.color, DEFAULT_RULE_COLOR, warnings, '渐变色标'),
    label: typeof value.label === 'string' ? value.label : '',
  };
}

function parseClassificationLayer(
  value: unknown,
  index: number,
  warnings: string[],
): ClassificationLayerState | null {
  if (!isRecord(value)) {
    warnings.push('存在非法的分类方案，已丢弃。');
    return null;
  }

  const mode = value.mode === 'rules' ? 'rules' : value.mode === 'gradient' ? 'gradient' : null;
  if (!mode) {
    warnings.push('分类方案缺少合法的模式，已丢弃。');
    return null;
  }

  const id = typeof value.id === 'string' && value.id.length > 0 ? value.id : `classification-restored-${index + 1}`;
  const label = typeof value.label === 'string' && value.label.length > 0 ? value.label : `恢复的方案 ${index + 1}`;
  const noDataColor = parseColor(value.noDataColor, DEFAULT_NO_DATA_COLOR, warnings, '方案背景');
  const visible = typeof value.visible === 'boolean' ? value.visible : true;

  if (mode === 'rules') {
    const rawRules = Array.isArray(value.rules) ? value.rules.slice(0, MAX_RULES) : [];
    const rules = rawRules
      .map((rule) => parseRule(rule, warnings))
      .filter((rule): rule is RasterClassificationRule => rule !== null);

    if (rules.length === 0) {
      warnings.push('规则方案没有任何可用规则，已丢弃。');
      return null;
    }

    return {
      id,
      label,
      noDataColor,
      visible,
      mode: 'rules',
      gradientStops: [],
      rules: rules as [RasterClassificationRule, ...RasterClassificationRule[]],
    };
  }

  const rawStops = Array.isArray(value.gradientStops) ? value.gradientStops.slice(0, MAX_GRADIENT_STOPS) : [];
  const stops = rawStops
    .map((stop) => parseGradientStop(stop, warnings))
    .filter((stop): stop is RasterGradientStop => stop !== null);

  if (stops.length === 0) {
    warnings.push('渐变方案没有任何可用色标，已丢弃。');
    return null;
  }

  return {
    id,
    label,
    noDataColor,
    visible,
    mode: 'gradient',
    gradientStops: stops as [RasterGradientStop, ...RasterGradientStop[]],
    rules: [],
  };
}

function parseLayers(
  value: unknown,
  warnings: string[],
): ClassificationLayerState[] {
  if (!Array.isArray(value)) {
    return [];
  }

  if (value.length > MAX_CLASSIFICATION_LAYERS) {
    warnings.push(`分类方案超过 ${MAX_CLASSIFICATION_LAYERS} 个，已截断。`);
  }

  const layers: ClassificationLayerState[] = [];
  const seenIds = new Set<string>();

  value.slice(0, MAX_CLASSIFICATION_LAYERS).forEach((rawLayer, index) => {
    const layer = parseClassificationLayer(rawLayer, index, warnings);
    if (!layer) {
      return;
    }

    // 去重，避免重复 id 让「当前方案」指向歧义
    if (seenIds.has(layer.id)) {
      layer.id = `${layer.id}-restored`;
    }
    seenIds.add(layer.id);
    layers.push(layer);
  });

  return layers;
}

const AGGREGATION_MODES: readonly GridAggregationMode[] = ['mean', 'max', 'min'];

function parseGrid(value: unknown, warnings: string[]): ProjectSnapshotGrid {
  const grid = isRecord(value) ? value : {};

  const cellSize = isFiniteNumber(grid.cellSize) && grid.cellSize > 0 ? grid.cellSize : 1;
  if (cellSize !== grid.cellSize) {
    warnings.push('网格尺寸非法，已回退为 1 米。');
  }

  const rotation = isFiniteNumber(grid.rotation) ? normalizeRotation(grid.rotation) : 0;

  const aggregationMode = AGGREGATION_MODES.includes(grid.aggregationMode as GridAggregationMode)
    ? (grid.aggregationMode as GridAggregationMode)
    : 'mean';
  if (aggregationMode !== grid.aggregationMode) {
    warnings.push('聚合方式非法，已回退为均值。');
  }

  return { cellSize, rotation, aggregationMode };
}

function parseView(value: unknown, warnings: string[]): ProjectSnapshotView {
  const view = isRecord(value) ? value : {};
  const layers = isRecord(view.layers) ? view.layers : {};
  const render = isRecord(view.gridRenderSettings) ? view.gridRenderSettings : {};

  const bool = (input: unknown, fallback: boolean, key: LayerKey) => {
    if (typeof input === 'boolean') {
      return input;
    }
    warnings.push(`图层显隐 ${key} 非法，已回退为 ${fallback}。`);
    return fallback;
  };

  /** 数值区间收敛：损坏文件里的 1e9 透明度不应直接进入渲染样式 */
  const boundedOr = (
    input: unknown,
    fallback: number,
    min: number,
    max: number,
    what: string,
  ): number => {
    // 字段缺省视为「未设置」，按默认值处理且不告警；只有显式给出非法值才提示
    if (input === undefined || input === null) {
      return fallback;
    }

    if (!isFiniteNumber(input)) {
      warnings.push(`${what}非法，已回退为 ${fallback}。`);
      return fallback;
    }

    const bounded = Math.min(Math.max(input, min), max);
    if (bounded !== input) {
      warnings.push(`${what}超出 ${min}~${max}，已收敛为 ${bounded}。`);
    }

    return bounded;
  };

  return {
    layers: {
      raster: bool(layers.raster, true, 'raster'),
      fence: bool(layers.fence, true, 'fence'),
      grid: bool(layers.grid, true, 'grid'),
    },
    gridRenderSettings: {
      useClassificationColors:
        typeof render.useClassificationColors === 'boolean' ? render.useClassificationColors : true,
      fillColor: parseColor(render.fillColor, '#3388ff', warnings, '网格填充'),
      fillOpacity: boundedOr(render.fillOpacity, 0.3, 0, 1, '网格填充透明度'),
      strokeColor: parseColor(render.strokeColor, '#3388ff', warnings, '网格边框'),
      strokeOpacity: boundedOr(render.strokeOpacity, 0.8, 0, 1, '网格边框透明度'),
      strokeWidth: boundedOr(render.strokeWidth, 1, 0, MAX_STROKE_WIDTH, '网格边框宽度'),
    },
  };
}

function parseDerived(value: unknown): ProjectSnapshotDerived {
  const derived = isRecord(value) ? value : {};

  return {
    exportNoDataValue: isFiniteNumber(derived.exportNoDataValue) ? derived.exportNoDataValue : null,
    aggregated: typeof derived.aggregated === 'boolean' ? derived.aggregated : true,
    prescriptionBandIndex: isFiniteNumber(derived.prescriptionBandIndex)
      ? derived.prescriptionBandIndex
      : null,
  };
}

function parseSource(value: unknown): ProjectSnapshotSource | null {
  if (!isRecord(value) || !isRecord(value.fingerprint)) {
    return null;
  }

  const fingerprint = value.fingerprint;
  if (
    typeof fingerprint.fileName !== 'string' ||
    !isFiniteNumber(fingerprint.size) ||
    !isFiniteNumber(fingerprint.lastModified)
  ) {
    return null;
  }

  const bbox = value.boundingBox;
  const boundingBox =
    Array.isArray(bbox) && bbox.length === 4 && bbox.every(isFiniteNumber)
      ? ([bbox[0], bbox[1], bbox[2], bbox[3]] as [number, number, number, number])
      : null;

  const resolutionSource = value.resolution;
  const resolution: [number, number, number?] =
    Array.isArray(resolutionSource) &&
    resolutionSource.length >= 2 &&
    isFiniteNumber(resolutionSource[0]) &&
    isFiniteNumber(resolutionSource[1])
      ? isFiniteNumber(resolutionSource[2])
        ? [resolutionSource[0], resolutionSource[1], resolutionSource[2]]
        : [resolutionSource[0], resolutionSource[1]]
      : [0, 0];

  return {
    fingerprint: {
      fileName: fingerprint.fileName,
      size: fingerprint.size,
      lastModified: fingerprint.lastModified,
    },
    sourceLabel: typeof value.sourceLabel === 'string' ? value.sourceLabel : fingerprint.fileName,
    crsCode: typeof value.crsCode === 'string' ? value.crsCode : 'UNKNOWN',
    width: isFiniteNumber(value.width) ? value.width : 0,
    height: isFiniteNumber(value.height) ? value.height : 0,
    boundingBox: boundingBox ?? [0, 0, 0, 0],
    resolution,
  };
}

export function validateProjectSnapshot(raw: unknown): SnapshotParseResult {
  if (!isRecord(raw)) {
    return { ok: false, errors: ['工程内容不是对象。'] };
  }

  if (raw.kind !== PROJECT_SNAPSHOT_KIND) {
    return { ok: false, errors: ['不是本工具的工程文件。'] };
  }

  if (!isFiniteNumber(raw.version) || raw.version < 1) {
    return { ok: false, errors: ['工程文件缺少有效的版本号。'] };
  }

  if (raw.version > PROJECT_SNAPSHOT_VERSION) {
    return {
      ok: false,
      errors: [`该工程由更新版本创建（v${raw.version}），请升级工具后再打开。`],
    };
  }

  const warnings: string[] = [];
  const fenceRecord = isRecord(raw.fence) ? raw.fence : null;
  const classificationRecord = isRecord(raw.classification) ? raw.classification : {};

  const snapshot: ProjectSnapshotV1 = {
    kind: PROJECT_SNAPSHOT_KIND,
    version: PROJECT_SNAPSHOT_VERSION,
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : new Date().toISOString(),
    source: parseSource(raw.source),
    fence: fenceRecord ? (() => {
      const rings = parseRings(fenceRecord.rings, warnings);
      return rings ? { rings } : null;
    })() : null,
    grid: parseGrid(raw.grid, warnings),
    classification: {
      layers: parseLayers(classificationRecord.layers, warnings),
      activeLayerId:
        typeof classificationRecord.activeLayerId === 'string' ? classificationRecord.activeLayerId : null,
      visibleLayerId:
        typeof classificationRecord.visibleLayerId === 'string' ? classificationRecord.visibleLayerId : null,
    },
    view: parseView(raw.view, warnings),
    derived: parseDerived(raw.derived),
  };

  if (snapshot.classification.layers.length === 0) {
    warnings.push('工程中没有可用的分类方案，已保留当前方案。');
  }

  return { ok: true, snapshot, warnings };
}

export function decodeEmbeddedSnapshot(text: string | null | undefined): SnapshotParseResult | null {
  if (!text) {
    return null;
  }

  // TIFF 的 ASCII tag 以 NUL 结尾，geotiff.js 会把该终止符原样带回来，
  // 不剥掉的话 base64 解码必然失败。
  const normalized = text.replace(/\0+$/, '');

  if (!normalized.startsWith(EMBEDDED_SNAPSHOT_PREFIX)) {
    return null;
  }

  const payload = normalized.slice(EMBEDDED_SNAPSHOT_PREFIX.length);

  try {
    return validateProjectSnapshot(JSON.parse(fromBase64(payload)));
  } catch {
    return { ok: false, errors: ['内嵌工程信息已损坏，无法解析。'] };
  }
}

export function parseProjectSnapshot(text: string): SnapshotParseResult {
  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['工程文件不是合法的 JSON。'] };
  }

  return validateProjectSnapshot(raw);
}
