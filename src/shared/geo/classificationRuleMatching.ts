/**
 * 分类规则的边界判定。
 *
 * 历史问题：预览/图例用**左闭右开** `[min, max)`，导出用**左闭右闭** `[min, max]`，
 * 于是恰好等于某个规则上界的像元，屏幕上一个颜色、机器却施另一个量。
 *
 * 现已统一到**左闭右闭**，理由是成本与风险不对等：
 * - 导出是机器读的产物，统一到闭区间可以**一字不改**，处方分配零风险；
 * - 预览只在"像元值恰好等于规则上界"时才有差异，浮点数据几乎不会命中；
 * - 等面积分级的断点选择（丢弃等于数据最大值的末位断点）本来就是按闭区间推导的，
 *   切到半开区间反而要连带返工。
 *
 * 两个常量保留各自名字：调用点仍然显式表达"这是哪一侧的判定"，
 * 若将来某个面需要不同语义，改一处即可。
 */

import type { RasterClassificationRule } from '@/shared/types/raster';

export type RuleBoundarySemantics = 'half-open' | 'closed';

/** 预览、图例、hover 使用的语义（已与导出一致） */
export const PREVIEW_RULE_SEMANTICS: RuleBoundarySemantics = 'closed';

/** 导出使用的语义（历史行为，保持闭区间以免改变机器读到的处方） */
export const EXPORT_RULE_SEMANTICS: RuleBoundarySemantics = 'closed';

type RuleBounds = Pick<RasterClassificationRule, 'min' | 'max'>;

/**
 * 判断数值是否命中规则。
 *
 * 非有限值（NaN/±Infinity）一律不命中——导出路径原本就是这个行为，
 * 预览路径的公开入口也已提前挡掉非有限值，因此这里统一处理不改变任何现有结果。
 */
export function matchesRule(
  rule: RuleBounds,
  value: number,
  semantics: RuleBoundarySemantics,
): boolean {
  if (!Number.isFinite(value)) {
    return false;
  }

  if (value < rule.min) {
    return false;
  }

  if (rule.max === null || rule.max === undefined) {
    return true;
  }

  return semantics === 'half-open' ? value < rule.max : value <= rule.max;
}

/**
 * 按顺序查找首个命中的规则。
 * 返回下标是必要的：调用方常需按规则序号取预计算结果（如每格用量）。
 */
export function findRuleMatch<T extends RuleBounds>(
  rules: readonly T[],
  value: number,
  semantics: RuleBoundarySemantics,
): { rule: T; index: number } | null {
  for (let index = 0; index < rules.length; index += 1) {
    if (matchesRule(rules[index], value, semantics)) {
      return { rule: rules[index], index };
    }
  }

  return null;
}
