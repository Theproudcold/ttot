import { describe, expect, it } from 'vitest';

import {
  EXPORT_RULE_SEMANTICS,
  PREVIEW_RULE_SEMANTICS,
  findRuleMatch,
  matchesRule,
} from '@/shared/geo/classificationRuleMatching';

const boundRule = { min: 0.2, max: 0.6 };
const openEndedRule = { min: 0, max: null };

describe('rule boundary semantics', () => {
  it('treats the upper bound as exclusive for preview', () => {
    expect(PREVIEW_RULE_SEMANTICS).toBe('half-open');
    expect(matchesRule(boundRule, 0.2, 'half-open')).toBe(true);
    expect(matchesRule(boundRule, 0.4, 'half-open')).toBe(true);
    // 恰好等于上界 → 不属于本级
    expect(matchesRule(boundRule, 0.6, 'half-open')).toBe(false);
  });

  it('treats the upper bound as inclusive for export', () => {
    expect(EXPORT_RULE_SEMANTICS).toBe('closed');
    expect(matchesRule(boundRule, 0.2, 'closed')).toBe(true);
    expect(matchesRule(boundRule, 0.6, 'closed')).toBe(true);
    expect(matchesRule(boundRule, 0.61, 'closed')).toBe(false);
  });

  it('never matches below the lower bound, in either semantic', () => {
    expect(matchesRule(boundRule, 0.1999, 'half-open')).toBe(false);
    expect(matchesRule(boundRule, 0.1999, 'closed')).toBe(false);
  });

  it('treats a null upper bound as unbounded', () => {
    expect(matchesRule(openEndedRule, 1e9, 'half-open')).toBe(true);
    expect(matchesRule(openEndedRule, 1e9, 'closed')).toBe(true);
  });

  it('never matches non-finite values', () => {
    // 非有限值一律不命中：导出路径原本就是这个行为，预览入口也已提前挡掉，
    // 因此这里统一处理不放宽任何现有结果。
    for (const semantics of ['half-open', 'closed'] as const) {
      expect(matchesRule(openEndedRule, Number.NaN, semantics)).toBe(false);
      expect(matchesRule(openEndedRule, Number.POSITIVE_INFINITY, semantics)).toBe(false);
    }
  });
});

describe('findRuleMatch', () => {
  const rules = [
    { min: 0, max: 1, color: '#111111', label: '低' },
    { min: 1, max: 2, color: '#222222', label: '中' },
  ];

  it('documents the divergence at an exact boundary', () => {
    // 同一个断点值：预览归到上一级，导出归到下一级
    expect(findRuleMatch(rules, 1, PREVIEW_RULE_SEMANTICS)?.index).toBe(1);
    expect(findRuleMatch(rules, 1, EXPORT_RULE_SEMANTICS)?.index).toBe(0);
  });

  it('returns the matched rule together with its index', () => {
    const match = findRuleMatch(rules, 1.5, EXPORT_RULE_SEMANTICS);

    expect(match?.index).toBe(1);
    expect(match?.rule.label).toBe('中');
  });

  it('returns null when nothing matches', () => {
    expect(findRuleMatch(rules, 5, EXPORT_RULE_SEMANTICS)).toBeNull();
    expect(findRuleMatch(rules, -1, EXPORT_RULE_SEMANTICS)).toBeNull();
    expect(findRuleMatch([], 1, EXPORT_RULE_SEMANTICS)).toBeNull();
  });
});
