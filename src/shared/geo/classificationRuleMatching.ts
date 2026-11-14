/**
 * 分类规则的边界判定。
 *
 * 背景（既有不一致，已登记为待决策项）：
 * - 预览/图例使用**左闭右开** `[min, max)`；
 * - 导出使用**左闭右闭** `[min, max]`。
 *
 * 于是恰好落在某个断点上的像元，屏幕上一个颜色、机器却施另一个量。
 * 统一会改变导出的处方分配（影响机器读取），因此本次**不改行为**，
 * 只把两种语义显式命名并收敛到一处：日后统一时改调用点常量即可，
 * 并由测试同时钉住两侧当前行为，防止差异继续扩散。
 */

import type { RasterClassificationRule } from '@/shared/types/raster';

export type RuleBoundarySemantics = 'half-open' | 'closed';

/** 预览、图例、hover 使用的语义 */
export const PREVIEW_RULE_SEMANTICS: RuleBoundarySemantics = 'half-open';

/** 导出使用的语义（历史行为，改动即改变机器读到的处方） */
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
