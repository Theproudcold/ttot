/**
 * 植被指数计算。
 *
 * 现状问题：界面里的"NDVI 默认分级"只是给主波段原始值套一条色带，
 * 并没有做任何指数运算——所以真正要出 NDVI 处方图，只能让用户先在外部算好。
 *
 * 本模块提供纯计算能力：
 * - 标量版 `computeIndexValue`：给定各波段的像元值，算出指数值；
 * - 栅格版 `computeIndexRaster`：给定各波段的数组，算出指数栅格与有效统计。
 *
 * 设计取舍：
 * 1. 不裁剪结果范围。数学上归一化差值指数落在 [-1, 1]，但输入异常时可能越界，
 *    裁剪会掩盖数据问题；此处只保证结果有限，越界交由分类规则处理。
 * 2. 无法计算时返回 null / NaN，而不是 0——0 是合法指数值（裸土），不可混淆。
 * 3. 波段按**语义角色**（red/green/blue/redEdge/nir）而非索引传入，
 *    真正的"波段识别"是后续步骤，本模块只负责算得对。
 */

import { isValidRasterSample } from './rasterPreview';

export type VegetationIndexId = 'ndvi' | 'gndvi' | 'ndre' | 'savi' | 'evi' | 'vari';

export type SpectralBandRole = 'blue' | 'green' | 'red' | 'redEdge' | 'nir';

export type VegetationIndexDefinition = {
  id: VegetationIndexId;
  label: string;
  /** 展示用公式，便于在界面上向用户解释 */
  formula: string;
  requiredBands: readonly SpectralBandRole[];
};

/** 归一化差值型指数的分母保护阈值：两者都接近 0 时该像元无意义 */
const DIVISION_EPSILON = 1e-10;

/** SAVI 的土壤调节因子默认值 */
export const DEFAULT_SAVI_SOIL_FACTOR = 0.5;

/** EVI 的默认系数（MOD13 系列常用取值） */
export const DEFAULT_EVI_COEFFICIENTS = {
  gain: 2.5,
  c1: 6,
  c2: 7.5,
  soilFactor: 1,
} as const;

export const SPECTRAL_BAND_ROLE_LABELS: Record<SpectralBandRole, string> = {
  blue: '蓝',
  green: '绿',
  red: '红',
  redEdge: '红边',
  nir: '近红外',
};

export const VEGETATION_INDEX_DEFINITIONS: Record<VegetationIndexId, VegetationIndexDefinition> = {
  ndvi: {
    id: 'ndvi',
    label: 'NDVI 归一化植被指数',
    formula: '(NIR - Red) / (NIR + Red)',
    requiredBands: ['nir', 'red'],
  },
  gndvi: {
    id: 'gndvi',
    label: 'GNDVI 绿光归一化植被指数',
    formula: '(NIR - Green) / (NIR + Green)',
    requiredBands: ['nir', 'green'],
  },
  ndre: {
    id: 'ndre',
    label: 'NDRE 红边归一化指数',
    formula: '(NIR - RedEdge) / (NIR + RedEdge)',
    requiredBands: ['nir', 'redEdge'],
  },
  savi: {
    id: 'savi',
    label: 'SAVI 土壤调节植被指数',
    formula: '((NIR - Red) / (NIR + Red + L)) × (1 + L)',
    requiredBands: ['nir', 'red'],
  },
  evi: {
    id: 'evi',
    label: 'EVI 增强型植被指数',
    formula: 'G × (NIR - Red) / (NIR + C1 × Red - C2 × Blue + L)',
    requiredBands: ['nir', 'red', 'blue'],
  },
  vari: {
    id: 'vari',
    label: 'VARI 可见光大气阻抗指数',
    formula: '(Green - Red) / (Green + Red - Blue)',
    requiredBands: ['green', 'red', 'blue'],
  },
};

export const VEGETATION_INDEX_IDS = Object.keys(VEGETATION_INDEX_DEFINITIONS) as VegetationIndexId[];

export function getVegetationIndexDefinition(id: VegetationIndexId): VegetationIndexDefinition {
  return VEGETATION_INDEX_DEFINITIONS[id];
}

export type VegetationIndexOptions = {
  /** SAVI 土壤调节因子 L，默认 0.5 */
  soilFactor?: number;
  /** EVI 增益 G，默认 2.5 */
  gain?: number;
  /** EVI 气溶胶抵抗项 C1，默认 6 */
  c1?: number;
  /** EVI 气溶胶抵抗项 C2，默认 7.5 */
  c2?: number;
};

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/**
 * 归一化差值：(a - b) / (a + b)。
 * 任一输入非有限、或分母接近 0 时返回 null。
 */
export function normalizedDifference(a: number, b: number): number | null {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return null;
  }

  const denominator = a + b;
  if (Math.abs(denominator) < DIVISION_EPSILON) {
    return null;
  }

  return finiteOrNull((a - b) / denominator);
}

/**
 * 计算单个像元的植被指数值。
 *
 * @returns 指数值；缺波段或数值非法时返回 null（**不是 0**）
 */
export function computeIndexValue(
  index: VegetationIndexId,
  bands: Partial<Record<SpectralBandRole, number>>,
  options: VegetationIndexOptions = {},
): number | null {
  const nir = bands.nir;
  const red = bands.red;
  const green = bands.green;
  const blue = bands.blue;
  const redEdge = bands.redEdge;

  switch (index) {
    case 'ndvi': {
      if (nir === undefined || red === undefined) return null;
      return normalizedDifference(nir, red);
    }

    case 'gndvi': {
      if (nir === undefined || green === undefined) return null;
      return normalizedDifference(nir, green);
    }

    case 'ndre': {
      if (nir === undefined || redEdge === undefined) return null;
      return normalizedDifference(nir, redEdge);
    }

    case 'savi': {
      if (nir === undefined || red === undefined) return null;
      if (!Number.isFinite(nir) || !Number.isFinite(red)) return null;

      const soilFactor =
        Number.isFinite(options.soilFactor) && options.soilFactor !== undefined
          ? options.soilFactor
          : DEFAULT_SAVI_SOIL_FACTOR;
      const denominator = nir + red + soilFactor;

      if (Math.abs(denominator) < DIVISION_EPSILON) return null;
      return finiteOrNull(((nir - red) / denominator) * (1 + soilFactor));
    }

    case 'evi': {
      if (nir === undefined || red === undefined || blue === undefined) return null;
      if (!Number.isFinite(nir) || !Number.isFinite(red) || !Number.isFinite(blue)) return null;

      const gain = options.gain ?? DEFAULT_EVI_COEFFICIENTS.gain;
      const c1 = options.c1 ?? DEFAULT_EVI_COEFFICIENTS.c1;
      const c2 = options.c2 ?? DEFAULT_EVI_COEFFICIENTS.c2;
      const soilFactor = options.soilFactor ?? DEFAULT_EVI_COEFFICIENTS.soilFactor;
      const denominator = nir + c1 * red - c2 * blue + soilFactor;

      if (Math.abs(denominator) < DIVISION_EPSILON) return null;
      return finiteOrNull((gain * (nir - red)) / denominator);
    }

    case 'vari': {
      if (green === undefined || red === undefined || blue === undefined) return null;
      if (!Number.isFinite(green) || !Number.isFinite(red) || !Number.isFinite(blue)) return null;

      const denominator = green + red - blue;
      if (Math.abs(denominator) < DIVISION_EPSILON) return null;
      return finiteOrNull((green - red) / denominator);
    }

    default:
      return null;
  }
}

export type VegetationIndexRaster = {
  index: VegetationIndexId;
  width: number;
  height: number;
  /** 与 width × height 等长；无法计算的像元为 NaN */
  data: Float32Array;
  validCount: number;
  totalCount: number;
  /** 有效像元的取值范围；无有效像元时为 null */
  range: { min: number; max: number } | null;
};

/**
 * 计算整幅指数栅格。
 *
 * 缺波段或波段长度不一致属于调用方错误，直接抛错；
 * 像元级的无值/非法输入则产出 NaN，不抛错。
 */
export function computeIndexRaster(input: {
  index: VegetationIndexId;
  width: number;
  height: number;
  bands: Partial<Record<SpectralBandRole, ArrayLike<number>>>;
  noDataValue?: number | null;
  options?: VegetationIndexOptions;
}): VegetationIndexRaster {
  const { index, width, height, bands, noDataValue = null, options } = input;

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('计算植被指数需要合法的影像宽高');
  }

  const pixelCount = Math.floor(width) * Math.floor(height);
  const definition = VEGETATION_INDEX_DEFINITIONS[index];

  for (const role of definition.requiredBands) {
    const band = bands[role];

    if (!band) {
      throw new Error(`植被指数 ${index} 需要「${SPECTRAL_BAND_ROLE_LABELS[role]}」波段`);
    }

    if (band.length !== pixelCount) {
      throw new Error(
        `植被指数 ${index} 的「${SPECTRAL_BAND_ROLE_LABELS[role]}」波段长度与影像尺寸不一致`,
      );
    }
  }

  const data = new Float32Array(pixelCount);
  let validCount = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  const roles = definition.requiredBands;

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const samples: Partial<Record<SpectralBandRole, number>> = {};
    let usable = true;

    for (const role of roles) {
      const value = bands[role]![pixel] as number;

      if (!isValidRasterSample(value, noDataValue)) {
        usable = false;
        break;
      }

      samples[role] = value;
    }

    const result = usable ? computeIndexValue(index, samples, options) : null;

    if (result === null) {
      data[pixel] = Number.NaN;
      continue;
    }

    data[pixel] = result;
    validCount += 1;
    min = Math.min(min, result);
    max = Math.max(max, result);
  }

  return {
    index,
    width: Math.floor(width),
    height: Math.floor(height),
    data,
    validCount,
    totalCount: pixelCount,
    range: validCount > 0 ? { min, max } : null,
  };
}
