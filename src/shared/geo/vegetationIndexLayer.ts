/**
 * 植被指数 → 分类图层的接线层。
 *
 * 把"识别波段 → 计算指数 → 等面积分级 → 生成分类方案"串成一次纯函数调用，
 * 这样界面侧只剩「选指数、看预览、确认」这点交互，不需要理解中间的波段与统计细节。
 *
 * 本模块不 import 任何 store，也不做副作用——结果由调用方写入状态。
 */

import type { RasterClassificationLayer } from '@/shared/types/raster';

import type { BandRoleAssignment } from './bandIdentification';
import {
  DEFAULT_EQUAL_AREA_CLASS_COUNT,
  DEFAULT_EQUAL_AREA_COLORS,
  buildEqualAreaClassification,
  type EqualAreaClassification,
} from './classificationHistogram';
import {
  compileCustomIndex,
  computeCustomIndexRaster,
  type CustomIndexRaster,
} from './customIndex';
import {
  VEGETATION_INDEX_DEFINITIONS,
  SPECTRAL_BAND_ROLE_LABELS,
  computeIndexRaster,
  type SpectralBandRole,
  type VegetationIndexId,
  type VegetationIndexOptions,
  type VegetationIndexRaster,
} from './vegetationIndex';

export const DEFAULT_VEGETATION_INDEX_LAYER_ID = 'vegetation-index';
export const DEFAULT_VEGETATION_INDEX_NO_DATA_COLOR = '#00000000';

/** 带显隐标记的分类方案，与 mapUiStore 中的图层形状一致 */
export type VegetationIndexLayer = RasterClassificationLayer & { visible: boolean };

export type VegetationIndexLayerPlan = {
  index: VegetationIndexId;
  raster: VegetationIndexRaster;
  classification: EqualAreaClassification;
  layer: VegetationIndexLayer;
};

/**
 * 把「按波段索引排列的数组」按角色分配映射成「按角色取用的波段」。
 * 越界或未分配的波段会被忽略——真正的缺角色检查交给指数计算（会给出明确报错）。
 */
export function resolveRoleBands(input: {
  bandArrays: ReadonlyArray<ArrayLike<number>>;
  assignment: BandRoleAssignment;
}): Partial<Record<SpectralBandRole, ArrayLike<number>>> {
  const { bandArrays, assignment } = input;
  const bands: Partial<Record<SpectralBandRole, ArrayLike<number>>> = {};

  for (const [role, bandIndex] of Object.entries(assignment) as Array<
    [SpectralBandRole, number | undefined]
  >) {
    if (bandIndex === undefined) {
      continue;
    }

    const band = bandArrays[bandIndex];
    if (band) {
      bands[role] = band;
    }
  }

  return bands;
}

export function describeMissingBands(
  index: VegetationIndexId,
  bands: Partial<Record<SpectralBandRole, ArrayLike<number>>>,
): SpectralBandRole[] {
  return VEGETATION_INDEX_DEFINITIONS[index].requiredBands.filter((role) => !bands[role]);
}

/**
 * 生成一套"指数 + 等面积分级"的分类方案。
 *
 * @returns 无法分级（无有效像元、或数据取值无法切分）时返回 null；
 *          缺波段属于调用方错误，直接抛错并指明缺哪个波段。
 */
export function prepareVegetationIndexLayer(input: {  index: VegetationIndexId;
  width: number;
  height: number;
  bands: Partial<Record<SpectralBandRole, ArrayLike<number>>>;
  noDataValue?: number | null;
  classCount?: number;
  colors?: readonly string[];
  labelPrefix?: string;
  layerId?: string;
  layerLabel?: string;
  options?: VegetationIndexOptions;
}): VegetationIndexLayerPlan | null {
  const {
    index,
    width,
    height,
    bands,
    noDataValue = null,
    classCount = DEFAULT_EQUAL_AREA_CLASS_COUNT,
    colors = DEFAULT_EQUAL_AREA_COLORS,
    labelPrefix = '分级 ',
    layerId = DEFAULT_VEGETATION_INDEX_LAYER_ID,
    layerLabel,
    options,
  } = input;

  const missing = describeMissingBands(index, bands);
  if (missing.length > 0) {
    const names = missing.map((role) => `「${SPECTRAL_BAND_ROLE_LABELS[role]}」`).join('、');
    throw new Error(`计算 ${index} 需要${names}波段，当前波段分配缺失。`);
  }

  const raster = computeIndexRaster({ index, width, height, bands, noDataValue, options });
  const classification = buildEqualAreaClassification({
    values: raster.data,
    classCount,
    colors,
    labelPrefix,
  });

  if (!classification) {
    return null;
  }

  const label = layerLabel ?? `${VEGETATION_INDEX_DEFINITIONS[index].label} 等面积分级`;

  return {
    index,
    raster,
    classification,
    layer: buildLayer(layerId, label, classification),
  };
}

function buildLayer(
  layerId: string,
  label: string,
  classification: EqualAreaClassification,
): VegetationIndexLayer {
  return {
    id: layerId,
    label,
    noDataColor: DEFAULT_VEGETATION_INDEX_NO_DATA_COLOR,
    visible: true,
    mode: 'rules',
    gradientStops: [],
    rules: classification.rules as [
      (typeof classification.rules)[number],
      ...(typeof classification.rules)[number][],
    ],
  };
}

export type CustomIndexLayerPlan = {
  source: string;
  raster: CustomIndexRaster;
  classification: EqualAreaClassification;
  layer: VegetationIndexLayer;
};

/**
 * 自定义公式版的等价流程：编译 → 算栅格 → 等面积分级 → 生成方案。
 * 编译失败时抛出，错误信息带位置，界面可直接展示。
 */
export function prepareCustomIndexLayer(input: {
  source: string;
  width: number;
  height: number;
  bands: Partial<Record<SpectralBandRole, ArrayLike<number>>>;
  noDataValue?: number | null;
  classCount?: number;
  colors?: readonly string[];
  labelPrefix?: string;
  layerId?: string;
  layerLabel?: string;
}): CustomIndexLayerPlan | null {
  const {
    source,
    width,
    height,
    bands,
    noDataValue = null,
    classCount = DEFAULT_EQUAL_AREA_CLASS_COUNT,
    colors = DEFAULT_EQUAL_AREA_COLORS,
    labelPrefix = '分级 ',
    layerId = 'custom-index',
    layerLabel,
  } = input;

  const compiled = compileCustomIndex(source);

  if (!compiled.ok) {
    const first = compiled.errors[0];
    throw new Error(`公式无法使用：${first?.message ?? '语法错误'}`);
  }

  const missing = compiled.index.requiredBands.filter((role) => !bands[role]);
  if (missing.length > 0) {
    const names = missing.map((role) => `「${SPECTRAL_BAND_ROLE_LABELS[role]}」`).join('、');
    throw new Error(`自定义公式需要${names}波段，当前波段分配缺失。`);
  }

  const raster = computeCustomIndexRaster({
    compiled: compiled.index,
    width,
    height,
    bands,
    noDataValue,
  });

  const classification = buildEqualAreaClassification({
    values: raster.data,
    classCount,
    colors,
    labelPrefix,
  });

  if (!classification) {
    return null;
  }

  return {
    source: compiled.index.source,
    raster,
    classification,
    layer: buildLayer(layerId, layerLabel ?? `自定义指数（${compiled.index.source}）等面积分级`, classification),
  };
}
