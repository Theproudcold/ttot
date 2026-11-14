/**
 * 工程配方（Project Snapshot）契约层。
 *
 * 设计要点：
 * 1. 只序列化「输入」，不序列化「派生结果」——格子（cells）、摘要（summary）、
 *    度量变换（metricTransform）等一律在还原后重算，避免配方与结果不一致。
 * 2. 本模块**不含任何副作用**，不 import 任何 store；写 store 的动作在
 *    `applyProjectSnapshot.ts` 中，便于对纯函数做往返测试。
 * 3. 校验器对可修复问题就地修复并返回 warning，对结构性问题返回 error，
 *    保证陌生/损坏文件不会让应用崩溃。
 *
 * 详见 docs/superpowers/specs/2026-11-14-project-roundtrip-design.md
 */

import type { FenceRings } from '@/shared/types/fence';
import type { GridAggregationMode, GridRenderSettings } from '@/shared/types/grid';
import {
  isApplicationRateBasis,
  isApplicationRateUnit,
} from '@/shared/geo/applicationRate';
import type {
  RasterClassificationLayer,
  RasterClassificationRule,
  RasterGradientStop,
  RasterMetadata,
} from '@/shared/types/raster';

export const PROJECT_SNAPSHOT_KIND = 'ttot-project';
export const PROJECT_SNAPSHOT_VERSION = 1;
export const EMBEDDED_SNAPSHOT_PREFIX = 'TTOT1:';

/** 指纹中时间戳的允许误差（部分平台复制/解压会改写 mtime） */
export const FINGERPRINT_MTIME_TOLERANCE_MS = 2000;

// 校验上限：防止陌生文件造成内存/时间爆炸
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

export type LayerKey = 'raster' | 'fence' | 'grid';
export type LayerVisibilityState = Record<LayerKey, boolean>;

/** 带 visible 字段的分类方案（UI 状态） */
export type ClassificationLayerState = RasterClassificationLayer & { visible: boolean };

export type SourceFileFingerprint = {
  fileName: string;
  size: number;
  lastModified: number;
};

export type ProjectSnapshotSource = {
  fingerprint: SourceFileFingerprint;
  sourceLabel: string;
  crsCode: string;
  width: number;
  height: number;
  boundingBox: [number, number, number, number];
  resolution: [number, number, number?];
};

export type ProjectSnapshotGrid = {
  cellSize: number;
  /** 规范化到 [0, 360) */
  rotation: number;
  aggregationMode: GridAggregationMode;
};

export type ProjectSnapshotClassification = {
  layers: ClassificationLayerState[];
  activeLayerId: string | null;
  visibleLayerId: string | null;
};

export type ProjectSnapshotView = {
  layers: LayerVisibilityState;
  gridRenderSettings: GridRenderSettings;
};

export type ProjectSnapshotDerived = {
  exportNoDataValue: number | null;
  aggregated: boolean;
  prescriptionBandIndex: number | null;
};

export type ProjectSnapshotV1 = {
  kind: typeof PROJECT_SNAPSHOT_KIND;
  version: 1;
  savedAt: string;
  appVersion?: string;
  source: ProjectSnapshotSource | null;
  fence: { rings: FenceRings } | null;
  grid: ProjectSnapshotGrid;
  classification: ProjectSnapshotClassification;
  view: ProjectSnapshotView;
  derived: ProjectSnapshotDerived;
};

export type SnapshotParseResult =
  | { ok: true; snapshot: ProjectSnapshotV1; warnings: string[] }
  | { ok: false; errors: string[] };

/** 纯函数往返测试的输入切片（避免依赖 store 的具体类型） */
export type ExportProjectSnapshotInput = {
  sourceFile: File | null;
  sourceLabel: string;
  metadata: RasterMetadata | null;
  fenceRings: FenceRings | null;
  grid: ProjectSnapshotGrid;
  classification: ProjectSnapshotClassification;
  view: ProjectSnapshotView;
  derived?: Partial<ProjectSnapshotDerived>;
};

export type ProjectStorePatches = {
  fenceRings: FenceRings | null;
  grid: ProjectSnapshotGrid;
  classification: ProjectSnapshotClassification;
  view: ProjectSnapshotView;
};

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

export function normalizeRotation(degrees: number): number {
  if (!Number.isFinite(degrees)) {
    return 0;
  }

  return ((degrees % 360) + 360) % 360;
}

export function fingerprintFromFile(file: File): SourceFileFingerprint {
  return {
    fileName: file.name,
    size: file.size,
    lastModified: file.lastModified,
  };
}

export type FingerprintMatch = 'match' | 'mtime-differs' | 'mismatch';

/**
 * 比较保存的指纹与当前文件。
 * 判定不阻断流程，仅用于提示——最终是否继续由用户决定。
 */
export function compareFingerprint(
  saved: SourceFileFingerprint,
  current: SourceFileFingerprint,
): FingerprintMatch {
  if (saved.fileName !== current.fileName || saved.size !== current.size) {
    return 'mismatch';
  }

  if (Math.abs(saved.lastModified - current.lastModified) > FINGERPRINT_MTIME_TOLERANCE_MS) {
    return 'mtime-differs';
  }

  return 'match';
}

// ---------------------------------------------------------------------------
// 生成配方
// ---------------------------------------------------------------------------

function cloneRules(
  rules: ReadonlyArray<RasterClassificationRule>,
): RasterClassificationRule[] {
  return rules.map((rule) => ({ ...rule }));
}

function cloneGradientStops(
  stops: ReadonlyArray<RasterGradientStop>,
): RasterGradientStop[] {
  return stops.map((stop) => ({ ...stop }));
}

export function cloneClassificationLayer(
  layer: ClassificationLayerState,
): ClassificationLayerState {
  if (layer.mode === 'rules') {
    return {
      id: layer.id,
      label: layer.label,
      noDataColor: layer.noDataColor,
      visible: layer.visible,
      mode: 'rules',
      gradientStops: [],
      rules: cloneRules(layer.rules) as ClassificationLayerState['rules'],
    } as ClassificationLayerState;
  }

  return {
    id: layer.id,
    label: layer.label,
    noDataColor: layer.noDataColor,
    visible: layer.visible,
    mode: 'gradient',
    gradientStops: cloneGradientStops(
      layer.gradientStops,
    ) as ClassificationLayerState['gradientStops'],
    rules: [],
  } as ClassificationLayerState;
}

function buildSourceBlock(
  input: Pick<ExportProjectSnapshotInput, 'sourceFile' | 'sourceLabel' | 'metadata'>,
): ProjectSnapshotSource | null {
  const { sourceFile, sourceLabel, metadata } = input;

  // 没有元信息就无法记录 CRS/范围，此时不写 source 块，避免记录出无意义的默认值
  if (!sourceFile || !metadata) {
    return null;
  }

  return {
    fingerprint: fingerprintFromFile(sourceFile),
    sourceLabel,
    crsCode: metadata.crsCode,
    width: metadata.width,
    height: metadata.height,
    boundingBox: [...metadata.boundingBox] as [number, number, number, number],
    resolution: [...metadata.resolution] as [number, number, number?],
  };
}

export function exportProjectSnapshot(input: ExportProjectSnapshotInput): ProjectSnapshotV1 {
  return {
    kind: PROJECT_SNAPSHOT_KIND,
    version: PROJECT_SNAPSHOT_VERSION,
    savedAt: new Date().toISOString(),
    source: buildSourceBlock(input),
    fence: input.fenceRings ? { rings: input.fenceRings.map((ring) => ring.map((p) => [...p] as [number, number])) } : null,
    grid: {
      cellSize: input.grid.cellSize,
      rotation: normalizeRotation(input.grid.rotation),
      aggregationMode: input.grid.aggregationMode,
    },
    classification: {
      layers: input.classification.layers.map(cloneClassificationLayer),
      activeLayerId: input.classification.activeLayerId,
      visibleLayerId: input.classification.visibleLayerId,
    },
    view: {
      layers: { ...input.view.layers },
      gridRenderSettings: { ...input.view.gridRenderSettings },
    },
    derived: {
      exportNoDataValue: input.derived?.exportNoDataValue ?? null,
      aggregated: input.derived?.aggregated ?? true,
      prescriptionBandIndex: input.derived?.prescriptionBandIndex ?? null,
    },
  };
}

/**
 * 配方 -> store 补丁。纯函数，返回防御性拷贝，避免补丁与配方共享引用。
 */
export function toStorePatches(snapshot: ProjectSnapshotV1): ProjectStorePatches {
  const layers = snapshot.classification.layers.map(cloneClassificationLayer);
  const layerIds = new Set(layers.map((layer) => layer.id));

  return {
    fenceRings: snapshot.fence
      ? snapshot.fence.rings.map((ring) => ring.map((p) => [...p] as [number, number]))
      : null,
    grid: {
      cellSize: snapshot.grid.cellSize,
      rotation: normalizeRotation(snapshot.grid.rotation),
      aggregationMode: snapshot.grid.aggregationMode,
    },
    classification: {
      layers,
      activeLayerId:
        snapshot.classification.activeLayerId && layerIds.has(snapshot.classification.activeLayerId)
          ? snapshot.classification.activeLayerId
          : layers[0]?.id ?? null,
      visibleLayerId:
        snapshot.classification.visibleLayerId && layerIds.has(snapshot.classification.visibleLayerId)
          ? snapshot.classification.visibleLayerId
          : layers.find((layer) => layer.visible)?.id ?? layers[0]?.id ?? null,
    },
    view: {
      layers: { ...snapshot.view.layers },
      gridRenderSettings: { ...snapshot.view.gridRenderSettings },
    },
  };
}

// ---------------------------------------------------------------------------
// 序列化 / 内嵌编码
// ---------------------------------------------------------------------------

export function serializeProjectSnapshot(snapshot: ProjectSnapshotV1): string {
  return JSON.stringify(snapshot, null, 2);
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';

  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }

  return btoa(binary);
}

function fromBase64(encoded: string): string {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new TextDecoder().decode(bytes);
}

/** 编码为可写入 TIFF ImageDescription 的 ASCII 安全字符串 */
export function encodeEmbeddedSnapshot(snapshot: ProjectSnapshotV1): string {
  return `${EMBEDDED_SNAPSHOT_PREFIX}${toBase64(JSON.stringify(snapshot))}`;
}

/**
 * 从内嵌字符串解析配方。
 * 返回 null 表示「不是本工具的配方」（例如其他软件写入的 ImageDescription），
 * 此时调用方应继续走普通影像流程。
 */
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

// ---------------------------------------------------------------------------
// 还原前置校验
// ---------------------------------------------------------------------------

/**
 * 还原动作：
 * - `apply`：可以直接还原；
 * - `request-source`：可以还原围栏/分类/网格参数，但需要用户重新选择源影像才能算聚合；
 * - `blocked`：保存的状态与当前影像不可比（CRS 不一致、围栏越界），不得自动还原。
 */
export type RestorePlanAction = 'apply' | 'request-source' | 'blocked';

export type RestorePlan = {
  action: RestorePlanAction;
  fingerprintMatch: FingerprintMatch | 'no-source' | 'no-current-file';
  crsMismatch: boolean;
  fenceOutsideRaster: boolean;
  errors: string[];
  warnings: string[];
};

// 与 mapUtils.isBboxInside 语义一致；刻意在本模块内实现，
// 以保持纯逻辑层不 import 任何 store / UI 模块。
function isBboxInside(
  inner: readonly [number, number, number, number],
  outer: readonly [number, number, number, number],
): boolean {
  return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

function getRingsBbox(rings: FenceRings): [number, number, number, number] | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const ring of rings) {
    for (const [x, y] of ring) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return null;
  }

  return [minX, minY, maxX, maxY];
}

/**
 * 纯函数：根据配方与「当前实际加载的影像」决定还原动作与提示。
 *
 * - 没有当前影像：只能还原围栏与设置，需要用户重新选择影像才能算聚合；
 * - 指纹不一致：提示但允许继续（由用户决定）；
 * - CRS 不一致：网格会整体偏移，因此要求重新选择影像，不自动还原。
 */
export function buildRestorePlan(input: {
  snapshot: ProjectSnapshotV1;
  currentFingerprint: SourceFileFingerprint | null;
  currentCrsCode?: string | null;
  currentBoundingBox?: readonly [number, number, number, number] | null;
}): RestorePlan {
  const { snapshot, currentFingerprint, currentCrsCode, currentBoundingBox } = input;
  const errors: string[] = [];
  const warnings: string[] = [];
  let action: RestorePlanAction = 'apply';

  if (!snapshot.source) {
    return {
      action: 'apply',
      fingerprintMatch: 'no-source',
      crsMismatch: false,
      fenceOutsideRaster: false,
      errors,
      warnings,
    };
  }

  let fingerprintMatch: RestorePlan['fingerprintMatch'];

  if (!currentFingerprint) {
    fingerprintMatch = 'no-current-file';
    action = 'request-source';
    warnings.push('已还原围栏与分类方案，请选择源影像以计算网格聚合。');
  } else {
    fingerprintMatch = compareFingerprint(snapshot.source.fingerprint, currentFingerprint);

    if (fingerprintMatch === 'mismatch') {
      warnings.push(
        `当前影像与工程记录的源文件不一致（记录：${snapshot.source.fingerprint.fileName}），继续可能得到错误结果。`,
      );
    } else if (fingerprintMatch === 'mtime-differs') {
      warnings.push('当前影像的时间戳与记录不同，已按同一文件处理。');
    }
  }

  const savedCrs = snapshot.source.crsCode;
  const normalizedSavedCrs = savedCrs?.trim().toUpperCase();
  const normalizedCurrentCrs = currentCrsCode?.trim().toUpperCase();
  const crsMismatch = Boolean(
    normalizedSavedCrs &&
      normalizedSavedCrs !== 'UNKNOWN' &&
      normalizedCurrentCrs &&
      normalizedCurrentCrs !== 'UNKNOWN' &&
      normalizedSavedCrs !== normalizedCurrentCrs,
  );

  if (crsMismatch) {
    errors.push(`影像坐标系不一致（记录 ${savedCrs}，当前 ${currentCrsCode}），网格位置会整体偏移，已停止自动还原。`);
    action = 'blocked';
  }

  let fenceOutsideRaster = false;

  if (snapshot.fence && currentBoundingBox) {
    const fenceBbox = getRingsBbox(snapshot.fence.rings);
    if (fenceBbox && !isBboxInside(fenceBbox, currentBoundingBox)) {
      fenceOutsideRaster = true;
      errors.push('围栏超出影像范围，请重新绘制或选择正确的影像。');
      // 有 error 就不能只靠调用方"记得检查 errors"：动作本身必须表达"不要自动还原"
      action = 'blocked';
    }
  }

  return { action, fingerprintMatch, crsMismatch, fenceOutsideRaster, errors, warnings };
}
