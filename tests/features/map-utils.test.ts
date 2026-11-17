import { describe, expect, it } from 'vitest';

import { canClassifySingleBand } from '@/features/map/mapUtils';
import {
  countExtraSamples,
  resolveDataBandCount,
} from '@/shared/geo/rasterPreview';

describe('countExtraSamples', () => {
  it('returns 0 when the tag is missing or the input is not a directory', () => {
    expect(countExtraSamples(undefined)).toBe(0);
    expect(countExtraSamples(null)).toBe(0);
    expect(countExtraSamples({})).toBe(0);
    expect(countExtraSamples({ ExtraSamples: 'nope' })).toBe(0);
  });

  it('accepts both the scalar and array forms produced by geotiff.js', () => {
    expect(countExtraSamples({ ExtraSamples: 0 })).toBe(1);
    expect(countExtraSamples({ ExtraSamples: [0] })).toBe(1);
    expect(countExtraSamples({ ExtraSamples: [0, 0] })).toBe(2);
    expect(countExtraSamples({ ExtraSamples: new Uint16Array([0, 0, 0]) })).toBe(3);
  });
});

describe('resolveDataBandCount', () => {
  it('subtracts declared extra bands from the sample count', () => {
    // 本工具导出的处方文件：1 个数据波段 + 1 个处方波段
    expect(resolveDataBandCount(2, 1)).toBe(1);
    expect(resolveDataBandCount(4, 1)).toBe(3);
    expect(resolveDataBandCount(3, 0)).toBe(3);
  });

  it('never drops below one band and tolerates junk input', () => {
    expect(resolveDataBandCount(1, 5)).toBe(1);
    expect(resolveDataBandCount(0, 0)).toBe(1);
    expect(resolveDataBandCount(Number.NaN, 0)).toBe(1);
    expect(resolveDataBandCount(2, -3)).toBe(2);
    expect(resolveDataBandCount(2, Number.NaN)).toBe(2);
  });
});

describe('canClassifySingleBand', () => {
  it('falls back to sampleBandCount when the new field is absent', () => {
    expect(canClassifySingleBand(null)).toBe(false);
    expect(canClassifySingleBand(undefined)).toBe(false);
    expect(canClassifySingleBand({})).toBe(false);
    expect(canClassifySingleBand({ sampleBandCount: 1 })).toBe(true);
    expect(canClassifySingleBand({ sampleBandCount: 3 })).toBe(false);
  });

  it('prefers classificationBandCount when present', () => {
    // 导出后重新导入的文件：样本数 2，但数据波段只有 1 个
    expect(canClassifySingleBand({ sampleBandCount: 2, classificationBandCount: 1 })).toBe(true);
    // 反向：样本数 1 但显式声明数据波段不是 1
    expect(canClassifySingleBand({ sampleBandCount: 1, classificationBandCount: 2 })).toBe(false);
  });
});
