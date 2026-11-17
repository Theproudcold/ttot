import { describe, expect, it } from 'vitest';

import {
  DEFAULT_APPLICATION_RATE_BASIS,
  DEFAULT_APPLICATION_RATE_UNIT,
  isApplicationRateBasis,
  isApplicationRateUnit,
  normalizeApplicationRateBasis,
  normalizeApplicationRateUnit,
  resolveCellAmount,
  summarizeApplicationRates,
} from '@/shared/geo/applicationRate';

describe('area units', () => {
  it('guards and normalizes unknown values', () => {
    expect(isApplicationRateBasis('per-area')).toBe(true);
    expect(isApplicationRateBasis('per-acre')).toBe(false);
    expect(isApplicationRateUnit('per-mu')).toBe(true);
    expect(isApplicationRateUnit('kg')).toBe(false);

    expect(normalizeApplicationRateBasis('per-area')).toBe('per-area');
    expect(normalizeApplicationRateBasis(undefined)).toBe(DEFAULT_APPLICATION_RATE_BASIS);
    expect(normalizeApplicationRateBasis('nope')).toBe(DEFAULT_APPLICATION_RATE_BASIS);
    expect(normalizeApplicationRateUnit('per-mu')).toBe('per-mu');
    expect(normalizeApplicationRateUnit(null)).toBe(DEFAULT_APPLICATION_RATE_UNIT);
  });
});

describe('resolveCellAmount', () => {
  const cellAreaM2 = 25; // 5m x 5m 的网格

  it('returns the raw value for per-cell rules (historical behavior)', () => {
    expect(resolveCellAmount({ applicationRate: 200 }, cellAreaM2)).toBe(200);
    expect(resolveCellAmount({ applicationRate: 200, applicationRateBasis: 'per-cell' }, cellAreaM2)).toBe(200);
    expect(resolveCellAmount({ applicationRate: 12.345 }, cellAreaM2)).toBe(12.345);
  });

  it('scales per-area rules by the cell area', () => {
    // 0.5 kg/m² × 25 m² = 12.5
    expect(
      resolveCellAmount(
        { applicationRate: 0.5, applicationRateBasis: 'per-area', applicationRateUnit: 'per-square-meter' },
        cellAreaM2,
      ),
    ).toBe(12.5);

    // 3 kg/ha × 25 m² ÷ 10000 = 0.0075
    expect(
      resolveCellAmount(
        { applicationRate: 3, applicationRateBasis: 'per-area', applicationRateUnit: 'per-hectare' },
        cellAreaM2,
      ),
    ).toBe(0.0075);

    // 1.2 kg/亩 × 25 m² ÷ (2000/3) = 0.045
    expect(
      resolveCellAmount(
        { applicationRate: 1.2, applicationRateBasis: 'per-area', applicationRateUnit: 'per-mu' },
        cellAreaM2,
      ),
    ).toBe(0.045);
  });

  it('defaults the unit to per-hectare when a per-area rule omits it', () => {
    expect(
      resolveCellAmount({ applicationRate: 3, applicationRateBasis: 'per-area' }, cellAreaM2),
    ).toBe(0.0075);
  });

  it('returns null when the amount is unusable', () => {
    expect(resolveCellAmount({ applicationRate: null }, cellAreaM2)).toBeNull();
    expect(resolveCellAmount({}, cellAreaM2)).toBeNull();
    expect(resolveCellAmount({ applicationRate: Number.NaN }, cellAreaM2)).toBeNull();
    expect(
      resolveCellAmount(
        { applicationRate: 1, applicationRateBasis: 'per-area', applicationRateUnit: 'per-hectare' },
        0,
      ),
    ).toBeNull();
  });
});

describe('summarizeApplicationRates', () => {
  it('aggregates per rule with the same basis used by exports', () => {
    const summary = summarizeApplicationRates({
      rules: [
        { applicationRate: 10 }, // per-cell，命中 2 格
        { applicationRate: 4, applicationRateBasis: 'per-area', applicationRateUnit: 'per-hectare' },
        { applicationRate: null },
      ],
      matchedCounts: [2, 3, 1],
      cellAreaM2: 100,
    });

    expect(summary.perRule[0]).toEqual({
      matchedCount: 2,
      areaM2: 200,
      cellAmount: 10,
      totalAmount: 20,
    });

    // 4 kg/ha × 100 m² ÷ 10000 = 0.04 每格；命中 3 格 → 0.12
    expect(summary.perRule[1].cellAmount).toBeCloseTo(0.04, 6);
    expect(summary.perRule[1].totalAmount).toBeCloseTo(0.12, 6);

    expect(summary.perRule[2]).toEqual({
      matchedCount: 1,
      areaM2: 100,
      cellAmount: null,
      totalAmount: 0,
    });

    expect(summary.totalAreaM2).toBe(600);
    expect(summary.totalAmount).toBeCloseTo(20.12, 6);
  });

  it('tolerates a missing matched count', () => {
    const summary = summarizeApplicationRates({
      rules: [{ applicationRate: 5 }],
      matchedCounts: [],
      cellAreaM2: 4,
    });

    expect(summary.perRule[0].matchedCount).toBe(0);
    expect(summary.totalAmount).toBe(0);
  });
});
