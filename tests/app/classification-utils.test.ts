import { describe, expect, it } from 'vitest';

import { formatMetricNumber } from '@/app/layout/right-panel/classificationUtils';

describe('formatMetricNumber', () => {
  it('returns "--" for null or undefined', () => {
    expect(formatMetricNumber(null)).toBe('--');
    expect(formatMetricNumber(undefined)).toBe('--');
  });

  it('formats integers without decimals', () => {
    expect(formatMetricNumber(100)).toBe('100');
    expect(formatMetricNumber(1000)).toBe('1,000');
  });

  it('formats values with up to two decimals', () => {
    expect(formatMetricNumber(100.5)).toBe('100.5');
    expect(formatMetricNumber(100.55)).toBe('100.55');
    expect(formatMetricNumber(100.555)).toBe('100.56');
  });

  it('cleans floating-point noise before formatting', () => {
    // 0.1 + 0.2 的经典浮点误差
    expect(formatMetricNumber(0.30000000000000004)).toBe('0.3');
    // 乘法产生的噪音
    expect(formatMetricNumber(33.3 * 3)).toBe('99.9');
    // 累加产生的噪音
    expect(formatMetricNumber(0.07 * 142)).toBe('9.94');
  });
});
