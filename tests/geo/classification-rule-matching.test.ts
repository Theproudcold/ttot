import { describe, expect, it } from 'vitest';

import { findRuleMatch, matchesRule } from '@/shared/geo/classificationRuleMatching';

const boundRule = { min: 0.2, max: 0.6 };
const openEndedRule = { min: 0, max: null };

describe('matchesRule（左闭右闭）', () => {
  it('includes both bounds', () => {
    expect(matchesRule(boundRule, 0.2)).toBe(true);
    expect(matchesRule(boundRule, 0.6)).toBe(true);
    expect(matchesRule(boundRule, 0.4)).toBe(true);
  });

  it('excludes values outside the closed interval', () => {
    expect(matchesRule(boundRule, 0.1999)).toBe(false);
    expect(matchesRule(boundRule, 0.6001)).toBe(false);
  });

  it('treats a null upper bound as unbounded', () => {
    expect(matchesRule(openEndedRule, 0)).toBe(true);
    expect(matchesRule(openEndedRule, 1e9)).toBe(true);
  });

  it('never matches non-finite values', () => {
    expect(matchesRule(openEndedRule, Number.NaN)).toBe(false);
    expect(matchesRule(openEndedRule, Number.POSITIVE_INFINITY)).toBe(false);
    expect(matchesRule(openEndedRule, Number.NEGATIVE_INFINITY)).toBe(false);
  });
});

describe('findRuleMatch', () => {
  const rules = [
    { min: 0, max: 1, color: '#111111', label: '低' },
    { min: 1, max: 2, color: '#222222', label: '中' },
  ];

  it('resolves an exact boundary to the first matching rule', () => {
    // 闭区间下 1 同时命中两条规则，按顺序取首个
    expect(findRuleMatch(rules, 1)?.index).toBe(0);
  });

  it('returns the matched rule together with its index', () => {
    const match = findRuleMatch(rules, 1.5);

    expect(match?.index).toBe(1);
    expect(match?.rule.label).toBe('中');
  });

  it('returns null when nothing matches', () => {
    expect(findRuleMatch(rules, 5)).toBeNull();
    expect(findRuleMatch(rules, -1)).toBeNull();
    expect(findRuleMatch([], 1)).toBeNull();
  });
});
