import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EVI_COEFFICIENTS,
  DEFAULT_SAVI_SOIL_FACTOR,
  SPECTRAL_BAND_ROLE_LABELS,
  VEGETATION_INDEX_DEFINITIONS,
  VEGETATION_INDEX_IDS,
  computeIndexRaster,
  computeIndexValue,
  getVegetationIndexDefinition,
  normalizedDifference,
} from '@/shared/geo/vegetationIndex';

describe('index definitions', () => {
  it('describes every index with a label, formula and required bands', () => {
    for (const id of VEGETATION_INDEX_IDS) {
      const definition = VEGETATION_INDEX_DEFINITIONS[id];

      expect(definition.id).toBe(id);
      expect(definition.label.length).toBeGreaterThan(0);
      expect(definition.formula.length).toBeGreaterThan(0);
      expect(definition.requiredBands.length).toBeGreaterThan(0);
    }

    expect(getVegetationIndexDefinition('ndvi').requiredBands).toEqual(['nir', 'red']);
    expect(getVegetationIndexDefinition('evi').requiredBands).toEqual(['nir', 'red', 'blue']);
  });

  it('labels every spectral band role', () => {
    expect(Object.keys(SPECTRAL_BAND_ROLE_LABELS).sort()).toEqual([
      'blue',
      'green',
      'nir',
      'red',
      'redEdge',
    ]);
  });
});

describe('normalizedDifference', () => {
  it('computes the standard normalized difference', () => {
    expect(normalizedDifference(0.5, 0.1)).toBeCloseTo(0.666667, 6);
    expect(normalizedDifference(0.1, 0.5)).toBeCloseTo(-0.666667, 6);
  });

  it('returns null instead of a bogus value for unusable input', () => {
    expect(normalizedDifference(0, 0)).toBeNull();
    expect(normalizedDifference(1e-12, -1e-12)).toBeNull();
    expect(normalizedDifference(Number.NaN, 0.2)).toBeNull();
    expect(normalizedDifference(0.2, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('computeIndexValue', () => {
  it('computes each supported index', () => {
    // NDVI：(0.5 - 0.1) / 0.6
    expect(computeIndexValue('ndvi', { nir: 0.5, red: 0.1 })).toBeCloseTo(0.666667, 6);

    // GNDVI：(0.5 - 0.2) / 0.7
    expect(computeIndexValue('gndvi', { nir: 0.5, green: 0.2 })).toBeCloseTo(0.428571, 6);

    // NDRE：(0.6 - 0.2) / 0.8
    expect(computeIndexValue('ndre', { nir: 0.6, redEdge: 0.2 })).toBeCloseTo(0.5, 6);

    // SAVI：(0.4 / (0.5 + 0.1 + 0.5)) × 1.5
    expect(computeIndexValue('savi', { nir: 0.5, red: 0.1 })).toBeCloseTo(0.545455, 6);

    // EVI：2.5 × 0.4 / (0.5 + 0.6 - 0.375 + 1)
    expect(computeIndexValue('evi', { nir: 0.5, red: 0.1, blue: 0.05 })).toBeCloseTo(0.57971, 5);

    // VARI：(0.2 - 0.1) / (0.2 + 0.1 - 0.05)
    expect(computeIndexValue('vari', { green: 0.2, red: 0.1, blue: 0.05 })).toBeCloseTo(0.4, 6);
  });

  it('returns null when a required band is missing', () => {
    expect(computeIndexValue('ndvi', { nir: 0.5 })).toBeNull();
    expect(computeIndexValue('ndvi', { red: 0.1 })).toBeNull();
    expect(computeIndexValue('ndre', { nir: 0.5, red: 0.1 })).toBeNull();
    expect(computeIndexValue('evi', { nir: 0.5, red: 0.1 })).toBeNull();
  });

  it('returns null for non-finite or degenerate input rather than 0', () => {
    expect(computeIndexValue('ndvi', { nir: Number.NaN, red: 0.1 })).toBeNull();
    expect(computeIndexValue('ndvi', { nir: 0, red: 0 })).toBeNull();
    expect(computeIndexValue('vari', { green: 0.1, red: 0.1, blue: 0.2 })).toBeNull();
    expect(computeIndexValue('ndvi', { nir: Number.POSITIVE_INFINITY, red: 0.1 })).toBeNull();
    // EVI 的分母恒含 +L(=1)，全零输入在数学上是合法的 0，不应被当成无法计算
    expect(computeIndexValue('evi', { nir: 0, red: 0, blue: 0 })).toBe(0);
  });

  it('honors explicit SAVI soil factors, including 0', () => {
    expect(DEFAULT_SAVI_SOIL_FACTOR).toBe(0.5);
    // L = 1：(0.4 / 1.6) × 2
    expect(computeIndexValue('savi', { nir: 0.5, red: 0.1 }, { soilFactor: 1 })).toBeCloseTo(0.5, 6);
    // L = 0 退化为 NDVI，不能被默认值覆盖
    expect(computeIndexValue('savi', { nir: 0.5, red: 0.1 }, { soilFactor: 0 })).toBeCloseTo(
      0.666667,
      6,
    );
  });

  it('honors explicit EVI coefficients', () => {
    expect(DEFAULT_EVI_COEFFICIENTS.gain).toBe(2.5);
    // gain = 1：1 × 0.4 / 1.725
    expect(
      computeIndexValue('evi', { nir: 0.5, red: 0.1, blue: 0.05 }, { gain: 1 }),
    ).toBeCloseTo(0.231884, 6);
  });
});

describe('computeIndexRaster', () => {
  const base = {
    index: 'ndvi' as const,
    width: 2,
    height: 2,
    bands: {
      nir: Float32Array.from([0.5, 0.6, 0.4, 0.5]),
      red: Float32Array.from([0.1, 0.2, 0.4, 0.1]),
    },
  };

  it('computes a full raster with a value range', () => {
    const result = computeIndexRaster(base);

    expect(result.index).toBe('ndvi');
    expect(result.width).toBe(2);
    expect(result.height).toBe(2);
    expect(result.validCount).toBe(4);
    expect(result.totalCount).toBe(4);
    expect(Array.from(result.data)).toEqual([
      expect.closeTo(0.666667, 6),
      expect.closeTo(0.5, 6),
      expect.closeTo(0, 6),
      expect.closeTo(0.666667, 6),
    ]);
    expect(result.range?.min).toBeCloseTo(0, 6);
    expect(result.range?.max).toBeCloseTo(0.666667, 6);
  });

  it('marks no-data pixels as NaN and keeps them out of the range', () => {
    const result = computeIndexRaster({
      ...base,
      noDataValue: 0,
      bands: {
        nir: Float32Array.from([0.5, 0.6, 0.4, 0.5]),
        // 第三个像元的红波段为 0，按 noDataValue=0 视为无值
        red: Float32Array.from([0.1, 0.2, 0, 0.1]),
      },
    });

    expect(result.validCount).toBe(3);
    expect(Number.isNaN(result.data[2])).toBe(true);
    expect(result.range?.min).toBeCloseTo(0.5, 6);
    expect(result.range?.max).toBeCloseTo(0.666667, 6);
  });

  it('reports a null range when no pixel is usable', () => {    const result = computeIndexRaster({
      ...base,
      bands: {
        nir: Float32Array.from([0, 0, 0, 0]),
        red: Float32Array.from([0, 0, 0, 0]),
      },
    });

    expect(result.validCount).toBe(0);
    expect(result.range).toBeNull();
    expect(Array.from(result.data).every((value) => Number.isNaN(value))).toBe(true);
  });

  it('requires the no-data value to be exactly representable in the band dtype', () => {
    // Float32Array 里的 0.4 实际是 0.4000000059604645，与双精度 0.4 不相等，
    // 因此 0.4 不会被识别为无值。无值哨兵必须选目标类型中可精确表示的值（0、-9999 等）。
    const result = computeIndexRaster({
      index: 'ndvi',
      width: 2,
      height: 1,
      bands: {
        nir: Float32Array.from([0.5, 0.5]),
        red: Float32Array.from([0.4, 0.1]),
      },
      noDataValue: 0.4,
    });

    expect(result.validCount).toBe(2);
  });

  it('throws on caller mistakes instead of silently producing NaN', () => {
    expect(() =>
      computeIndexRaster({
        ...base,
        bands: { red: Float32Array.from([0.1, 0.2, 0.4, 0.1]) },
      }),
    ).toThrow('近红外');

    expect(() =>
      computeIndexRaster({
        ...base,
        bands: {
          nir: Float32Array.from([0.5, 0.6, 0.4]),
          red: Float32Array.from([0.1, 0.2, 0.4]),
        },
      }),
    ).toThrow('长度与影像尺寸不一致');

    expect(() => computeIndexRaster({ ...base, width: 0 })).toThrow('合法的影像宽高');
    expect(() =>
      computeIndexRaster({ ...base, index: 'evi' }),
    ).toThrow('蓝');
  });

  it('accepts plain arrays and applies index options', () => {
    const result = computeIndexRaster({
      index: 'savi',
      width: 2,
      height: 1,
      bands: {
        nir: [0.5, 0.5],
        red: [0.1, 0.1],
      },
      options: { soilFactor: 1 },
    });

    expect(Array.from(result.data)).toEqual([expect.closeTo(0.5, 6), expect.closeTo(0.5, 6)]);
  });
});
