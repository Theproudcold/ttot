import { describe, expect, it } from 'vitest';

import {
  DEFAULT_VEGETATION_INDEX_LAYER_ID,
  DEFAULT_VEGETATION_INDEX_NO_DATA_COLOR,
  describeMissingBands,
  prepareVegetationIndexLayer,
  resolveRoleBands,
} from '@/shared/geo/vegetationIndexLayer';

const nir = Float32Array.from([0.5, 0.6, 0.4, 0.5]);
const red = Float32Array.from([0.1, 0.2, 0.4, 0.1]);

describe('resolveRoleBands', () => {
  it('maps role assignments onto the per-band arrays', () => {
    const bands = resolveRoleBands({
      bandArrays: [new Float32Array([1]), new Float32Array([2]), new Float32Array([3])],
      assignment: { blue: 0, red: 2, nir: 1 },
    });

    expect(Array.from(bands.blue as Float32Array)).toEqual([1]);
    expect(Array.from(bands.nir as Float32Array)).toEqual([2]);
    expect(Array.from(bands.red as Float32Array)).toEqual([3]);
    expect(bands.green).toBeUndefined();
    expect(bands.redEdge).toBeUndefined();
  });

  it('ignores out-of-range and unassigned roles', () => {
    const bands = resolveRoleBands({
      bandArrays: [new Float32Array([1])],
      assignment: { red: 0, nir: 5, blue: undefined },
    });

    expect(bands.red).toBeDefined();
    expect(bands.nir).toBeUndefined();
    expect(bands.blue).toBeUndefined();
  });
});

describe('describeMissingBands', () => {
  it('lists the roles an index still needs', () => {
    expect(describeMissingBands('ndvi', { nir, red })).toEqual([]);
    expect(describeMissingBands('ndvi', { nir })).toEqual(['red']);
    expect(describeMissingBands('evi', { nir, red })).toEqual(['blue']);
    expect(describeMissingBands('ndvi', {})).toEqual(['nir', 'red']);
  });
});

describe('prepareVegetationIndexLayer', () => {
  it('turns an index raster into an equal-area rules layer in one call', () => {
    const plan = prepareVegetationIndexLayer({
      index: 'ndvi',
      width: 2,
      height: 2,
      bands: { nir, red },
      classCount: 2,
    });

    expect(plan).not.toBeNull();
    if (!plan) return;

    // NDVI 值：(0.4/0.6)=0.6667, (0.4/0.8)=0.5, 0/0.8=0, (0.4/0.6)=0.6667
    expect(plan.raster.validCount).toBe(4);
    expect(plan.raster.range?.min).toBeCloseTo(0, 6);

    expect(plan.classification.classCount).toBe(2);
    expect(plan.classification.counts).toEqual([2, 2]);
    expect(plan.classification.counts.reduce((sum, count) => sum + count, 0)).toBe(4);

    expect(plan.layer.id).toBe(DEFAULT_VEGETATION_INDEX_LAYER_ID);
    expect(plan.layer.mode).toBe('rules');
    expect(plan.layer.visible).toBe(true);
    expect(plan.layer.noDataColor).toBe(DEFAULT_VEGETATION_INDEX_NO_DATA_COLOR);
    expect(plan.layer.label).toContain('NDVI');
    expect(plan.layer.gradientStops).toEqual([]);

    // 首级从数据最小值开始，末级无上限
    if (plan.layer.mode !== 'rules') {
      throw new Error('等面积分级应当生成规则模式图层');
    }
    expect(plan.layer.rules).toHaveLength(2);
    expect(plan.layer.rules[0].min).toBe(0);
    expect(plan.layer.rules[1].max).toBeNull();
  });

  it('honours custom layer id, label, palette and class count', () => {
    // 用 4 个分散的 NDVI 值，保证 3 级都能存活
    const plan = prepareVegetationIndexLayer({
      index: 'ndvi',
      width: 2,
      height: 2,
      bands: {
        nir: Float32Array.from([0.6, 0.6, 0.6, 0.6]),
        red: Float32Array.from([0.1, 0.2, 0.3, 0.4]),
      },
      classCount: 3,
      colors: ['#111111', '#222222', '#333333'],
      labelPrefix: '等级',
      layerId: 'my-index-layer',
      layerLabel: '自定义指数方案',
    });

    expect(plan?.layer.id).toBe('my-index-layer');
    expect(plan?.layer.label).toBe('自定义指数方案');
    expect(plan?.classification.classCount).toBe(3);
    if (plan && plan.layer.mode === 'rules') {
      expect(plan.layer.rules.map((rule) => rule.color)).toEqual([
        '#111111',
        '#222222',
        '#333333',
      ]);
      expect(plan.layer.rules.map((rule) => rule.label)).toEqual(['等级1', '等级2', '等级3']);
    }
  });

  it('skips no-data pixels before splitting', () => {
    const plan = prepareVegetationIndexLayer({
      index: 'ndvi',
      width: 2,
      height: 2,
      bands: { nir, red: Float32Array.from([0.1, 0.2, 0.3, 0]) },
      // 哨兵取 0：在 Float32 中可精确表示，比较才可靠
      noDataValue: 0,
      classCount: 2,
    });

    // 第四个像元的红波段为 0（= noDataValue）→ 只剩 3 个有效像元
    expect(plan?.raster.validCount).toBe(3);
    expect(plan?.classification.totalValidCount).toBe(3);
  });

  it('returns null when nothing can be classified', () => {
    const plan = prepareVegetationIndexLayer({
      index: 'ndvi',
      width: 2,
      height: 2,
      bands: { nir: Float32Array.from([0, 0, 0, 0]), red: Float32Array.from([0, 0, 0, 0]) },
    });

    expect(plan).toBeNull();
  });

  it('names the missing bands instead of failing deep inside the math', () => {
    expect(() =>
      prepareVegetationIndexLayer({
        index: 'evi',
        width: 1,
        height: 1,
        bands: { nir: Float32Array.from([0.5]), red: Float32Array.from([0.1]) },
      }),
    ).toThrow('蓝');
  });
});
