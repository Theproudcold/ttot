/**
 * 光谱波段识别。
 *
 * 植被指数要求"哪个波段是红、哪个是近红外"，而 GeoTIFF 只给按顺序排列的样本。
 * 认反 NIR/Red 会让 NDVI 整体变号——处方图看起来正常但完全相反，
 * 比直接报错更危险。因此本模块不只给出结果，还必须给出**依据与置信度**。
 *
 * 识别分层（可靠性由高到低，命中即止，不做跨层拼凑）：
 * 1. `wavelength`：GDAL 元数据里的波长（nm），按最近中心归角色 —— 高置信；
 * 2. `band-name`：波段名/描述关键字（Nir、RedEdge、Red…）—— 中置信；
 * 3. `convention`：厂商/工具链的固定顺序（如 ODM 5 波段）—— 中/低置信；
 * 4. `reflectance-heuristic`：按波段均值猜测（NIR 反射率高、Red 因叶绿素吸收偏低）—— 低置信。
 *
 * 前两层读的是文件自带的元数据；后两层是**推测**，因此要求界面确认后才应生效。
 */

import {
  VEGETATION_INDEX_DEFINITIONS,
  VEGETATION_INDEX_IDS,
  type SpectralBandRole,
  type VegetationIndexId,
} from './vegetationIndex';

export type BandIdentificationMethod =
  | 'wavelength'
  | 'band-name'
  | 'convention'
  | 'reflectance-heuristic'
  | 'none';

export type BandIdentificationConfidence = 'high' | 'medium' | 'low';

/** 角色 -> 波段索引（0 基） */
export type BandRoleAssignment = Partial<Record<SpectralBandRole, number>>;

export type BandMetadataHint = {
  index: number;
  /** 中心波长，单位 nm */
  wavelength?: number | null;
  /** 波段名或描述 */
  name?: string | null;
  /** 该波段的有效像元均值，供兜底启发式使用 */
  mean?: number | null;
};

export type BandIdentificationResult = {
  assignment: BandRoleAssignment;
  method: BandIdentificationMethod;
  confidence: BandIdentificationConfidence;
  /**
   * 是否必须由用户确认后才生效。
   * 来自文件自带元数据（波长/波段名）时为 false；属于推测时为 true。
   */
  requiresConfirmation: boolean;
  reasons: string[];
  hints: BandMetadataHint[];
  /** 未能识别的角色 */
  missingRoles: SpectralBandRole[];
};

export const SPECTRAL_BAND_ROLE_ORDER: readonly SpectralBandRole[] = [
  'blue',
  'green',
  'red',
  'redEdge',
  'nir',
];

/** 各角色的典型中心波长（nm），用于按波长归类 */
const WAVELENGTH_CENTERS: Record<SpectralBandRole, number> = {
  blue: 475,
  green: 560,
  red: 660,
  redEdge: 720,
  nir: 840,
};

/** 波长与最近中心的最大容许偏差（nm），超出则视为无法判定 */
const WAVELENGTH_TOLERANCE_NM = 120;

/** 可能的波长字段名（大小写不敏感） */
const WAVELENGTH_KEYS = ['WAVELENGTH', 'WAVELENGTHS', 'CENTRALWAVELENGTH', 'CENTREWAVELENGTH'];
/** 可能的名称字段名（大小写不敏感） */
const NAME_KEYS = ['BANDNAME', 'NAME', 'DESCRIPTION', 'BAND_DESCRIPTION'];

/**
 * 名称关键字匹配。顺序关键：redEdge 必须早于 red，否则 "RedEdge" 会被判成 red。
 */
const NAME_PATTERNS: ReadonlyArray<{ role: SpectralBandRole; pattern: RegExp }> = [
  { role: 'redEdge', pattern: /red[\s_-]*edge|redge|\bre\b|\bre\d/i },
  { role: 'nir', pattern: /near[\s_-]*infra|nir|infra/i },
  { role: 'blue', pattern: /blue|\bblu\b|\bb\b/i },
  { role: 'green', pattern: /green|\bgrn\b|\bg\b/i },
  { role: 'red', pattern: /red|\br\b/i },
];

type Convention = {
  sampleCount: number;
  roles: readonly SpectralBandRole[];
  confidence: BandIdentificationConfidence;
  label: string;
};

const CONVENTIONS: readonly Convention[] = [
  {
    sampleCount: 5,
    roles: ['blue', 'green', 'red', 'redEdge', 'nir'],
    confidence: 'medium',
    label: 'ODM/WebODM 常见 5 波段顺序（蓝/绿/红/红边/近红外）',
  },
  {
    sampleCount: 3,
    roles: ['red', 'green', 'blue'],
    confidence: 'low',
    label: '常见 RGB 顺序（红/绿/蓝）——但 RGB 无法计算 NDVI 等指数',
  },
];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readKey(source: Record<string, unknown>, keys: readonly string[]): unknown {
  const upperKeys = keys.map((key) => key.toUpperCase());

  for (const [key, value] of Object.entries(source)) {
    if (upperKeys.includes(key.toUpperCase())) {
      return value;
    }
  }

  return undefined;
}

function parseNumberLike(value: unknown): number | null {
  if (isFiniteNumber(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

/**
 * 把各波段的 GDAL 元数据 + 均值整理成识别输入。
 * `metadataByBand` 通常是 `image.getGDALMetadata(sampleIndex)` 的返回值。
 */
export function buildBandHints(input: {
  sampleCount: number;
  metadataByBand?: ReadonlyArray<Record<string, unknown> | null | undefined>;
  bandMeans?: ReadonlyArray<number | null | undefined>;
}): BandMetadataHint[] {
  const { sampleCount, metadataByBand = [], bandMeans = [] } = input;

  return Array.from({ length: Math.max(0, Math.floor(sampleCount)) }, (_, index) => {
    const metadata = metadataByBand[index] ?? null;
    const wavelength = metadata ? parseNumberLike(readKey(metadata, WAVELENGTH_KEYS)) : null;
    const rawName = metadata ? readKey(metadata, NAME_KEYS) : undefined;
    const name = typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : null;
    const mean = isFiniteNumber(bandMeans[index]) ? (bandMeans[index] as number) : null;

    return { index, wavelength, name, mean };
  });
}

/** 计算交错排列样本的逐波段均值（忽略非有限值） */
export function computeInterleavedBandMeans(
  values: ArrayLike<number>,
  bandCount: number,
): Array<number | null> {
  const safeBandCount = Math.floor(bandCount);
  if (safeBandCount <= 0) {
    return [];
  }

  const sums = new Array<number>(safeBandCount).fill(0);
  const counts = new Array<number>(safeBandCount).fill(0);

  for (let offset = 0; offset + safeBandCount <= values.length; offset += safeBandCount) {
    for (let band = 0; band < safeBandCount; band += 1) {
      const value = values[offset + band];
      if (Number.isFinite(value)) {
        sums[band] += value;
        counts[band] += 1;
      }
    }
  }

  return sums.map((sum, band) => (counts[band] > 0 ? sum / counts[band] : null));
}

function roleFromWavelength(wavelength: number): SpectralBandRole | null {
  let best: SpectralBandRole | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const role of SPECTRAL_BAND_ROLE_ORDER) {
    const distance = Math.abs(wavelength - WAVELENGTH_CENTERS[role]);
    if (distance < bestDistance) {
      best = role;
      bestDistance = distance;
    }
  }

  return best !== null && bestDistance <= WAVELENGTH_TOLERANCE_NM ? best : null;
}

/**
 * 按名称判定角色。先判红边，避免 "RedEdge" 被 "red" 抢先命中。
 */
export function roleFromBandName(name: string): SpectralBandRole | null {
  for (const { role, pattern } of NAME_PATTERNS) {
    if (pattern.test(name)) {
      return role;
    }
  }

  return null;
}

function assignFromHints(
  hints: readonly BandMetadataHint[],
  selector: (hint: BandMetadataHint) => SpectralBandRole | null,
): BandRoleAssignment {
  const assignment: BandRoleAssignment = {};

  for (const hint of hints) {
    const role = selector(hint);
    if (role && assignment[role] === undefined) {
      assignment[role] = hint.index;
    }
  }

  return assignment;
}

function countAssigned(assignment: BandRoleAssignment): number {
  return SPECTRAL_BAND_ROLE_ORDER.filter((role) => assignment[role] !== undefined).length;
}

function getMissingRoles(assignment: BandRoleAssignment): SpectralBandRole[] {
  return SPECTRAL_BAND_ROLE_ORDER.filter((role) => assignment[role] === undefined);
}

/** 相对差异低于该阈值就不做均值猜测，避免在灰度图上硬猜 */
const MEAN_SEPARATION_RATIO = 0.05;

/**
 * 兜底启发式：NIR 通常反射率最高，Red 因叶绿素吸收而偏低。
 * 只给出 nir + red 两个角色的**提议**，其余角色一律不猜。
 */
function assignFromReflectance(
  hints: readonly BandMetadataHint[],
): { assignment: BandRoleAssignment; reason: string | null } {
  const usable = hints.filter((hint) => isFiniteNumber(hint.mean));

  if (usable.length < 2) {
    return { assignment: {}, reason: null };
  }

  const sorted = [...usable].sort((a, b) => (b.mean as number) - (a.mean as number));
  const highest = sorted[0];
  const lowest = sorted[sorted.length - 1];
  const span = Math.abs((highest.mean as number) - (lowest.mean as number));
  const reference = Math.max(Math.abs(highest.mean as number), Math.abs(lowest.mean as number));

  if (reference === 0 || span / reference < MEAN_SEPARATION_RATIO) {
    return { assignment: {}, reason: '各波段均值过于接近，无法按反射率推测波段角色。' };
  }

  return {
    assignment: { nir: highest.index, red: lowest.index },
    reason: `按波段均值推测：${highest.index} 号波段最高（假定近红外）、${lowest.index} 号最低（假定红）。`,
  };
}

/**
 * 识别光谱波段角色。
 *
 * 命中某一层后即停止，不做跨层拼凑——把"读到的元数据"和"猜的"混在一起，
 * 会让结果的可靠性无从表达。
 */
export function identifySpectralBands(input: {
  sampleCount: number;
  hints?: readonly BandMetadataHint[];
}): BandIdentificationResult {
  const sampleCount = Math.max(0, Math.floor(input.sampleCount));
  const hints =
    input.hints ?? Array.from({ length: sampleCount }, (_, index) => ({ index }) as BandMetadataHint);

  // 1. 波长元数据
  const fromWavelength = assignFromHints(hints, (hint) =>
    isFiniteNumber(hint.wavelength) ? roleFromWavelength(hint.wavelength) : null,
  );
  if (countAssigned(fromWavelength) > 0) {
    return finalize(
      fromWavelength,
      'wavelength',
      'high',
      hints,
      [`依据 ${countAssigned(fromWavelength)} 个波段的波长元数据判定角色。`],
    );
  }

  // 2. 波段名/描述
  const fromName = assignFromHints(hints, (hint) =>
    typeof hint.name === 'string' ? roleFromBandName(hint.name) : null,
  );
  if (countAssigned(fromName) > 0) {
    return finalize(
      fromName,
      'band-name',
      'medium',
      hints,
      [`依据 ${countAssigned(fromName)} 个波段的名称/描述判定角色。`],
    );
  }

  // 3. 约定顺序
  const convention = CONVENTIONS.find((item) => item.sampleCount === sampleCount);
  if (convention) {
    const assignment: BandRoleAssignment = {};
    convention.roles.forEach((role, index) => {
      if (index < sampleCount) {
        assignment[role] = index;
      }
    });

    return finalize(assignment, 'convention', convention.confidence, hints, [
      `按${convention.label}推测波段角色。`,
    ]);
  }

  // 4. 反射率启发式
  const heuristic = assignFromReflectance(hints);
  if (countAssigned(heuristic.assignment) > 0) {
    return finalize(
      heuristic.assignment,
      'reflectance-heuristic',
      'low',
      hints,
      heuristic.reason ? [heuristic.reason] : [],
    );
  }

  return finalize(
    {},
    'none',
    'low',
    hints,
    [heuristic.reason ?? '文件未提供波长或波段名，且无法通过反射率推测波段角色。'],
  );
}

function finalize(
  assignment: BandRoleAssignment,
  method: BandIdentificationMethod,
  confidence: BandIdentificationConfidence,
  hints: readonly BandMetadataHint[],
  reasons: string[],
): BandIdentificationResult {
  const missingRoles = getMissingRoles(assignment);

  return {
    assignment,
    method,
    confidence,
    // 只有从文件自带元数据读出来的才不需要用户确认
    requiresConfirmation: method !== 'wavelength' && method !== 'band-name',
    reasons,
    hints: [...hints],
    missingRoles,
  };
}

/**
 * 在给定波段分配下，哪些指数可以计算。
 * 供界面禁用不可用指数，避免让用户算出无意义的结果。
 */
export function resolveUsableIndices(assignment: BandRoleAssignment): VegetationIndexId[] {
  return VEGETATION_INDEX_IDS.filter((id) =>
    VEGETATION_INDEX_DEFINITIONS[id].requiredBands.every((role) => assignment[role] !== undefined),
  );
}
