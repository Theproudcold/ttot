/**
 * 分类规则的边界判定。
 *
 * 语义：**左闭右闭** `[min, max]`，全仓唯一口径。
 *
 * 历史：5156f9a 曾把「预览/图例用左闭右开、导出用左闭右闭」的分歧显式命名成
 * PREVIEW_RULE_SEMANTICS / EXPORT_RULE_SEMANTICS 两个常量，只收敛实现不改行为。
 * 3f62ba4 随后把两边统一到闭区间——导出是机器读的产物，统一到闭区间可以一字
 * 不改、处方分配零风险，因此以导出语义为准。
 *
 * 两个常量统一后取值相同，继续保留只会让「存在两种语义」的错觉留在代码里，
 * 故一并删除；若将来确有某个面需要半开区间，再按需重新引入并写明理由。
 */

import type { RasterClassificationRule } from '@/shared/types/raster';

type RuleBounds = Pick<RasterClassificationRule, 'min' | 'max'>;

/**
 * 判断数值是否命中规则（左闭右闭）。
 *
 * 非有限值（NaN/±Infinity）一律不命中。
 */
export function matchesRule(rule: RuleBounds, value: number): boolean {
  if (!Number.isFinite(value)) {
    return false;
  }

  if (value < rule.min) {
    return false;
  }

  if (rule.max === null || rule.max === undefined) {
    return true;
  }

  return value <= rule.max;
}

/**
 * 按顺序查找首个命中的规则。
 * 返回下标是必要的：调用方常需按规则序号取预计算结果（如每格用量）。
 */
export function findRuleMatch<T extends RuleBounds>(
  rules: readonly T[],
  value: number,
): { rule: T; index: number } | null {
  for (let index = 0; index < rules.length; index += 1) {
    if (matchesRule(rules[index], value)) {
      return { rule: rules[index], index };
    }
  }

  return null;
}
