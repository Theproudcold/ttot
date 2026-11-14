import { describe, expect, it } from 'vitest';

import {
  MAX_CUSTOM_INDEX_DEPTH,
  MAX_CUSTOM_INDEX_LENGTH,
  compileCustomIndex,
  computeCustomIndexRaster,
  resolveVariableRole,
} from '@/shared/geo/customIndex';

function expectCompiled(source: string) {
  const result = compileCustomIndex(source);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`公式应当编译成功：${source} → ${result.errors[0]?.message}`);
  }
  return result.index;
}

describe('resolveVariableRole', () => {
  it('accepts the canonical band names case-insensitively', () => {
    expect(resolveVariableRole('nir')).toBe('nir');
    expect(resolveVariableRole('NIR')).toBe('nir');
    expect(resolveVariableRole('redEdge')).toBe('redEdge');
    expect(resolveVariableRole('REDEDGE')).toBe('redEdge');
    expect(resolveVariableRole('blue')).toBe('blue');
  });

  it('rejects anything outside the whitelist', () => {
    expect(resolveVariableRole('ndvi')).toBeNull();
    expect(resolveVariableRole('constructor')).toBeNull();
    expect(resolveVariableRole('window')).toBeNull();
  });
});

describe('compileCustomIndex — evaluation', () => {
  it('evaluates arithmetic with correct precedence', () => {
    expect(expectCompiled('1 + 2 * 3').evaluate({})).toBe(7);
    expect(expectCompiled('(1 + 2) * 3').evaluate({})).toBe(9);
    expect(expectCompiled('10 - 2 - 3').evaluate({})).toBe(5);
    expect(expectCompiled('8 / 4 / 2').evaluate({})).toBe(1);
  });

  it('treats power as right-associative and unary minus as lower precedence', () => {
    expect(expectCompiled('2 ^ 3 ^ 2').evaluate({})).toBe(512);
    // -2^2 = -(2^2) = -4
    expect(expectCompiled('-2 ^ 2').evaluate({})).toBe(-4);
  });

  it('evaluates band expressions', () => {
    const diff = expectCompiled('nir - red');
    expect(diff.evaluate({ nir: 0.5, red: 0.1 })).toBeCloseTo(0.4, 6);

    const ndvi = expectCompiled('(nir - red) / (nir + red)');
    expect(ndvi.evaluate({ nir: 0.5, red: 0.1 })).toBeCloseTo(0.666667, 6);

    const negated = expectCompiled('-nir');
    expect(negated.evaluate({ nir: 0.5 })).toBeCloseTo(-0.5, 6);

    // 大小写不敏感
    expect(expectCompiled('NIR / Red').evaluate({ nir: 0.5, red: 0.1 })).toBeCloseTo(5, 6);
  });

  it('reports which bands the formula needs', () => {
    expect(expectCompiled('(nir - red) / (nir + red)').requiredBands).toEqual(['red', 'nir']);
    expect(expectCompiled('nir - redEdge').requiredBands).toEqual(['redEdge', 'nir']);
    expect(expectCompiled('nir').requiredBands).toEqual(['nir']);
    expect(expectCompiled('1 + 2').requiredBands).toEqual([]);
  });

  it('normalizes the stored source', () => {
    expect(expectCompiled('  nir - red  ').source).toBe('nir - red');
  });
});

describe('compileCustomIndex — returns null instead of a bogus value', () => {
  it('returns null when a required band is missing or non-finite', () => {
    const compiled = expectCompiled('nir - red');

    expect(compiled.evaluate({ nir: 0.5 })).toBeNull();
    expect(compiled.evaluate({ nir: Number.NaN, red: 0.1 })).toBeNull();
    expect(compiled.evaluate({ nir: 0.5, red: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it('returns null for division by zero', () => {
    const compiled = expectCompiled('(nir - red) / (nir + red)');

    expect(compiled.evaluate({ nir: 0, red: 0 })).toBeNull();
  });

  it('returns null when the result is not finite', () => {
    expect(expectCompiled('1e308 * 1e308').evaluate({})).toBeNull();
  });
});

describe('compileCustomIndex — rejects bad input', () => {
  function expectErrors(source: string) {
    const result = compileCustomIndex(source);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error(`公式应当被拒绝：${source}`);
    }
    return result.errors;
  }

  it('rejects empty formulas', () => {
    expect(expectErrors('')[0].message).toContain('不能为空');
    expect(expectErrors('   ')[0].message).toContain('不能为空');
  });

  it('rejects unknown band names and lists the valid ones', () => {
    const errors = expectErrors('ndvi * 2');

    expect(errors[0].message).toContain('未知波段');
    expect(errors[0].message).toContain('nir');
    expect(errors[0].position).toBe(0);
  });

  it('rejects syntax errors with a position', () => {
    expect(expectErrors('nir +')[0].message).toContain('不完整');
    expect(expectErrors('(nir')[0].message).toContain('括号');
    expect(expectErrors('nir)')[0].message).toContain('多余内容');
    expect(expectErrors('nir * / red')[0].message).toContain('缺少操作数');
    expect(expectErrors('nir $ red')[0].message).toContain('不支持的字符');
    expect(expectErrors('nir $ red')[0].position).toBe(4);
  });

  it('rejects overlong formulas', () => {
    const errors = expectErrors('nir'.repeat(MAX_CUSTOM_INDEX_LENGTH));
    expect(errors[0].message).toContain('过长');
  });

  it('rejects excessive nesting instead of blowing the stack', () => {
    const deep = `${'('.repeat(MAX_CUSTOM_INDEX_DEPTH + 2)}nir${')'.repeat(MAX_CUSTOM_INDEX_DEPTH + 2)}`;
    const errors = expectErrors(deep);

    expect(errors[0].message).toContain('嵌套过深');
  });

  it('does not evaluate arbitrary code', () => {
    // 白名单之外的一切都只是"未知波段"，不会被当成函数或全局对象
    expect(compileCustomIndex('constructor(1)').ok).toBe(false);
    expect(compileCustomIndex('window.alert(1)').ok).toBe(false);
    expect(compileCustomIndex('process.exit(0)').ok).toBe(false);
  });
});

describe('computeCustomIndexRaster', () => {
  const compiled = expectCompiled('(nir - red) / (nir + red)');

  it('computes the whole raster with a range', () => {
    const result = computeCustomIndexRaster({
      compiled,
      width: 2,
      height: 2,
      bands: {
        nir: Float32Array.from([0.5, 0.6, 0.4, 0.5]),
        red: Float32Array.from([0.1, 0.2, 0.4, 0.1]),
      },
    });

    expect(result.source).toContain('nir');
    expect(result.validCount).toBe(4);
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
    const result = computeCustomIndexRaster({
      compiled,
      width: 2,
      height: 2,
      bands: {
        nir: Float32Array.from([0.5, 0.6, 0.4, 0.5]),
        red: Float32Array.from([0.1, 0.2, 0, 0.1]),
      },
      noDataValue: 0,
    });

    expect(result.validCount).toBe(3);
    expect(Number.isNaN(result.data[2])).toBe(true);
    expect(result.range?.min).toBeCloseTo(0.5, 6);
  });

  it('reports a null range when nothing is usable', () => {
    const result = computeCustomIndexRaster({
      compiled,
      width: 1,
      height: 1,
      bands: { nir: Float32Array.from([0]), red: Float32Array.from([0]) },
    });

    expect(result.validCount).toBe(0);
    expect(result.range).toBeNull();
  });

  it('throws on caller mistakes', () => {
    expect(() =>
      computeCustomIndexRaster({
        compiled,
        width: 1,
        height: 1,
        bands: { nir: Float32Array.from([0.5]) },
      }),
    ).toThrow('红');

    expect(() =>
      computeCustomIndexRaster({
        compiled,
        width: 2,
        height: 1,
        bands: { nir: Float32Array.from([0.5]), red: Float32Array.from([0.1]) },
      }),
    ).toThrow('长度与影像尺寸不一致');

    expect(() =>
      computeCustomIndexRaster({
        compiled,
        width: 0,
        height: 1,
        bands: { nir: Float32Array.from([]), red: Float32Array.from([]) },
      }),
    ).toThrow('合法的影像宽高');
  });
});
