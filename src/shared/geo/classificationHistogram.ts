/**
 * 直方图与等面积自动分级。
 *
 * 对标竞品基线：Metashape 的处方表就是"直方图 + 分级断点 + Zonal mean/Area/Rate"，
 * NDVItoTaskmap 则提供"按等面积自动分级"。原先本工具只有手工规则，没有这一层。
 *
 * 注意口径：全仓统一的规则判定为左闭右闭、首个命中优先，因此本模块返回的
 * counts 与导出结果、以及预览着色都可逐格对上。
 */

import type { RasterClassificationRule } from '@/shared/types/raster';

import { findRuleMatch } from './classificationRuleMatching';

export type HistogramBin = {
  from: number;
  to: number;
  count: number;
};

export type Histogram = {
  bins: HistogramBin[];
  min: number;
  max: number;
  binWidth: number;
  validCount: number;
};

export const DEFAULT_HISTOGRAM_BIN_COUNT = 32;
export const DEFAULT_EQUAL_AREA_CLASS_COUNT = 5;

/** 等面积分级的默认配色（低→高，红→绿） */
export const DEFAULT_EQUAL_AREA_COLORS: readonly string[] = [
  '#d73027',
  '#fc8d59',
  '#fee08b',
  '#d9ef8b',
  '#1a9850',
  '#4575b4',
];

function roundTo(value: number, digits = 6): number {
  if (!Number.isFinite(value)) {
    return value;
  }

  return Number(value.toFixed(digits));
}

/** 收集有限值（忽略 NaN/±Infinity），升序排序 */
function collectSortedFiniteValues(values: ArrayLike<number>): number[] {
  const collected: number[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (Number.isFinite(value)) {
      collected.push(value);
    }
  }

  collected.sort((a, b) => a - b);
  return collected;
}

/**
 * 构建直方图。无有效像元时返回 null（而不是空图），便于调用方显式处理。
 */
export function buildHistogram(
  values: ArrayLike<number>,
  options: { binCount?: number; min?: number; max?: number } = {},
): Histogram | null {
  const sorted = collectSortedFiniteValues(values);
  if (sorted.length === 0) {
    return null;
  }

  const requestedBins = Math.floor(options.binCount ?? DEFAULT_HISTOGRAM_BIN_COUNT);
  const binCount = Number.isFinite(requestedBins) && requestedBins > 0 ? requestedBins : DEFAULT_HISTOGRAM_BIN_COUNT;

  const min = Number.isFinite(options.min) ? (options.min as number) : sorted[0];
  const max = Number.isFinite(options.max) ? (options.max as number) : sorted[sorted.length - 1];

  if (max < min) {
    throw new Error('直方图范围非法：max 不能小于 min');
  }

  // 单一取值：给一个包含该值的箱，避免除零
  if (max === min) {
    return {
      bins: [{ from: min, to: max, count: sorted.length }],
      min,
      max,
      binWidth: 0,
      validCount: sorted.length,
    };
  }

  const binWidth = (max - min) / binCount;
  const bins: HistogramBin[] = Array.from({ length: binCount }, (_, index) => ({
    from: min + index * binWidth,
    to: min + (index + 1) * binWidth,
    count: 0,
  }));

  for (const value of sorted) {
    const rawIndex = Math.floor((value - min) / binWidth);
    const binIndex = Math.min(binCount - 1, Math.max(0, rawIndex));
    bins[binIndex].count += 1;
  }

  return { bins, min, max, binWidth, validCount: sorted.length };
}

/**
 * 线性插值分位数（与常见 GIS/统计实现一致，避免用最近秩造成台阶）。
 */
function quantile(sortedValues: readonly number[], q: number): number {
  if (sortedValues.length === 0) {
    return Number.NaN;
  }

  const position = (sortedValues.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);

  if (lower === upper) {
    return sortedValues[lower];
  }

  const weight = position - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

/**
 * 计算等面积（等频）分级的内部断点，返回严格递增的断点数组。
 *
 * 两类退化会被消除，因此实际分级数可能少于请求值：
 * - 取值集中导致相邻分位数相等 → 合并重复断点；
 * - 末位断点恰好等于数据最大值 → 丢弃（否则最高一级必然为空，因为不存在更大的值）；
 * - 若最终没有任何断点，说明该数据无法分级，返回 null。
 */
export function computeEqualAreaBreaks(
  values: ArrayLike<number>,
  classCount: number,
): number[] | null {
  const requested = Math.floor(classCount);

  if (!Number.isFinite(requested) || requested < 2) {
    return null;
  }

  const sorted = collectSortedFiniteValues(values);

  // 至少要有 classCount 个有效像元，否则必然出现空类
  if (sorted.length < requested) {
    return null;
  }

  const breaks: number[] = [];

  for (let index = 1; index < requested; index += 1) {
    const value = roundTo(quantile(sorted, index / requested));
    const previous = breaks[breaks.length - 1];

    if (previous === undefined || value > previous) {
      breaks.push(value);
    }
  }

  const dataMax = sorted[sorted.length - 1];
  while (breaks.length > 0 && breaks[breaks.length - 1] >= dataMax) {
    breaks.pop();
  }

  if (breaks.length === 0) {
    return null;
  }

  return breaks;
}

export type EqualAreaClassification = {
  /** 与 rules 同序的命中像元数（按导出判定口径统计） */
  counts: number[];
  rules: RasterClassificationRule[];
  /** 内部断点 */
  breaks: number[];
  totalValidCount: number;
  histogram: Histogram;
  /** 请求的分级数 */
  requestedClassCount: number;
  /** 实际分出的级数（数据取值集中时可能少于请求值） */
  classCount: number;
};

/**
 * 生成等面积分级规则，可直接交给现有分类图层使用。
 *
 * 规则边界采用与导出一致的左闭右闭语义；最后一级 max 为 null（无上限）。
 */
export function buildEqualAreaClassification(input: {
  values: ArrayLike<number>;
  classCount?: number;
  colors?: readonly string[];
  labelPrefix?: string;
  binCount?: number;
}): EqualAreaClassification | null {
  const {
    values,
    classCount = DEFAULT_EQUAL_AREA_CLASS_COUNT,
    colors = DEFAULT_EQUAL_AREA_COLORS,
    labelPrefix = '分级 ',
    binCount,
  } = input;

  const sorted = collectSortedFiniteValues(values);
  if (sorted.length === 0) {
    return null;
  }

  const breaks = computeEqualAreaBreaks(sorted, classCount);
  if (!breaks || breaks.length === 0) {
    return null;
  }

  const histogram = buildHistogram(sorted, { binCount });
  if (!histogram) {
    return null;
  }

  const dataMin = sorted[0];
  const classTotal = breaks.length + 1;
  const palette = colors.length > 0 ? colors : DEFAULT_EQUAL_AREA_COLORS;

  const rules: RasterClassificationRule[] = Array.from({ length: classTotal }, (_, index) => ({
    min: index === 0 ? dataMin : breaks[index - 1],
    max: index === classTotal - 1 ? null : breaks[index],
    color: palette[index % palette.length],
    label: `${labelPrefix}${index + 1}`,
    applicationRate: null,
  }));

  // 与导出保持同一判定口径：左闭右闭 + 首个命中优先
  const counts = new Array<number>(classTotal).fill(0);

  for (const value of sorted) {
    const match = findRuleMatch(rules, value);
    if (match) {
      counts[match.index] += 1;
    }
  }

  return {
    counts,
    rules,
    breaks,
    totalValidCount: sorted.length,
    histogram,
    requestedClassCount: Math.floor(classCount),
    classCount: classTotal,
  };
}
