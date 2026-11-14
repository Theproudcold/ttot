import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EQUAL_AREA_CLASS_COUNT,
  DEFAULT_EQUAL_AREA_COLORS,
  DEFAULT_HISTOGRAM_BIN_COUNT,
  buildEqualAreaClassification,
  buildHistogram,
  computeEqualAreaBreaks,
} from '@/shared/geo/classificationHistogram';

describe('buildHistogram', () => {
  it('bins values evenly across the data range', () => {
    const histogram = buildHistogram([1, 2, 3, 4], { binCount: 2 });

    expect(histogram).not.toBeNull();
    expect(histogram?.min).toBe(1);
    expect(histogram?.max).toBe(4);
    expect(histogram?.binWidth).toBe(1.5);
    expect(histogram?.validCount).toBe(4);
    expect(histogram?.bins).toEqual([
      { from: 1, to: 2.5, count: 2 },
      { from: 2.5, to: 4, count: 2 },
    ]);
  });

  it('returns null when there is nothing to show', () => {
    expect(buildHistogram([])).toBeNull();
    expect(buildHistogram([Number.NaN, Number.POSITIVE_INFINITY])).toBeNull();
  });

  it('collapses to a single bin for a constant raster', () => {
    const histogram = buildHistogram([5, 5, 5]);

    expect(histogram?.bins).toEqual([{ from: 5, to: 5, count: 3 }]);
    expect(histogram?.binWidth).toBe(0);
  });

  it('honours an explicit range and clamps out-of-range values into the edge bins', () => {
    const histogram = buildHistogram([-5, 15], { min: 0, max: 10, binCount: 2 });

    expect(histogram?.min).toBe(0);
    expect(histogram?.max).toBe(10);
    expect(histogram?.bins.map((bin) => bin.count)).toEqual([1, 1]);
  });

  it('rejects an inverted range instead of producing nonsense', () => {
    expect(() => buildHistogram([1, 2, 3], { min: 10, max: 0 })).toThrow('max 不能小于 min');
  });

  it('falls back to the default bin count for unusable input', () => {
    const histogram = buildHistogram([1, 2], { binCount: 0 });

    expect(histogram?.bins).toHaveLength(DEFAULT_HISTOGRAM_BIN_COUNT);
  });
});

describe('computeEqualAreaBreaks', () => {
  it('splits the range into equal-count quantiles', () => {
    expect(computeEqualAreaBreaks([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5)).toEqual([2.8, 4.6, 6.4, 8.2]);
  });

  it('refuses impossible requests instead of returning empty classes', () => {
    expect(computeEqualAreaBreaks([1, 2, 3], 1)).toBeNull();
    expect(computeEqualAreaBreaks([1, 2], 5)).toBeNull();
    expect(computeEqualAreaBreaks([], 3)).toBeNull();
  });

  it('merges duplicate quantiles when the data is concentrated', () => {
    // 只有 1 和 2 两个取值，5 级请求会退化；末尾等于数据最大值的断点被丢弃，
    // 否则最高一级必然为空
    expect(computeEqualAreaBreaks([1, 1, 1, 1, 2, 2, 2, 2], 5)).toEqual([1]);
  });

  it('returns null when the data cannot be split at all', () => {
    expect(computeEqualAreaBreaks([5, 5, 5, 5], 3)).toBeNull();
  });
});

describe('buildEqualAreaClassification', () => {
  it('produces contiguous, equal-count rules ready for the existing layer', () => {
    const values = Array.from({ length: 10 }, (_, index) => index + 1);
    const result = buildEqualAreaClassification({ values });

    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.requestedClassCount).toBe(DEFAULT_EQUAL_AREA_CLASS_COUNT);
    expect(result.classCount).toBe(5);
    expect(result.breaks).toEqual([2.8, 4.6, 6.4, 8.2]);
    expect(result.totalValidCount).toBe(10);

    // 每级 2 个像元，且恰好覆盖全部有效像元
    expect(result.counts).toEqual([2, 2, 2, 2, 2]);
    expect(result.counts.reduce((sum, count) => sum + count, 0)).toBe(10);

    // 首级从数据最小值开始，末级无上限；相邻边界首尾相接
    expect(result.rules[0].min).toBe(1);
    expect(result.rules[result.rules.length - 1].max).toBeNull();
    for (let index = 1; index < result.rules.length; index += 1) {
      expect(result.rules[index].min).toBe(result.rules[index - 1].max);
    }

    expect(result.rules.map((rule) => rule.label)).toEqual([
      '分级 1',
      '分级 2',
      '分级 3',
      '分级 4',
      '分级 5',
    ]);
    expect(result.rules[0].color).toBe(DEFAULT_EQUAL_AREA_COLORS[0]);
    expect(result.rules.every((rule) => rule.applicationRate === null)).toBe(true);
  });

  it('reuses one histogram so the UI and the rules share the same view', () => {
    const result = buildEqualAreaClassification({
      values: Array.from({ length: 10 }, (_, index) => index + 1),
      binCount: 5,
    });

    expect(result?.histogram.bins).toHaveLength(5);
    expect(result?.histogram.validCount).toBe(10);
  });

  it('reports fewer classes when the data cannot support the request', () => {
    const result = buildEqualAreaClassification({ values: [1, 1, 1, 1, 2, 2, 2, 2], classCount: 5 });

    expect(result?.requestedClassCount).toBe(5);
    // 只有两个取值，实际只能分出两级，且不会留下空的高位分级
    expect(result?.classCount).toBe(2);
    expect(result?.breaks).toEqual([1]);
    expect(result?.counts).toEqual([4, 4]);
    expect(result?.counts.reduce((sum, count) => sum + count, 0)).toBe(8);
  });

  it('supports a custom palette and label prefix', () => {
    const result = buildEqualAreaClassification({
      values: [1, 2, 3, 4, 5, 6],
      classCount: 3,
      colors: ['#111111', '#222222', '#333333'],
      labelPrefix: '等级',
    });

    expect(result?.rules.map((rule) => rule.color)).toEqual(['#111111', '#222222', '#333333']);
    expect(result?.rules.map((rule) => rule.label)).toEqual(['等级1', '等级2', '等级3']);
  });

  it('cycles the palette when more classes than colours are requested', () => {
    const result = buildEqualAreaClassification({
      values: [1, 2, 3, 4, 5, 6, 7, 8],
      classCount: 8,
      colors: ['#111111', '#222222'],
    });

    expect(result?.rules.map((rule) => rule.color)).toEqual([
      '#111111',
      '#222222',
      '#111111',
      '#222222',
      '#111111',
      '#222222',
      '#111111',
      '#222222',
    ]);
  });

  it('returns null when there is nothing to classify', () => {
    expect(buildEqualAreaClassification({ values: [] })).toBeNull();
    expect(buildEqualAreaClassification({ values: [Number.NaN, Number.NaN] })).toBeNull();
  });
});
