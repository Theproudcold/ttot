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
import { normalizeRotation } from './rotation';
import type { GridAggregationMode, GridRenderSettings } from '@/shared/types/grid';
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

/** 编码为可写入 TIFF ImageDescription 的 ASCII 安全字符串 */
export function encodeEmbeddedSnapshot(snapshot: ProjectSnapshotV1): string {
  return `${EMBEDDED_SNAPSHOT_PREFIX}${toBase64(JSON.stringify(snapshot))}`;
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

// ---------------------------------------------------------------------------
// 校验入口（实现见 projectSnapshotSchema.ts）
// ---------------------------------------------------------------------------

/**
 * 校验与解析实现在 `projectSnapshotSchema.ts`；此处重新导出，
 * 使「契约 + 校验」对外仍是同一个模块入口，调用方无需关心拆分。
 */
export {
  decodeEmbeddedSnapshot,
  parseProjectSnapshot,
  validateProjectSnapshot,
} from './projectSnapshotSchema';
export { normalizeRotation } from './rotation';
