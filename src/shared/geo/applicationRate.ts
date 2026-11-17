/**
 * 施用量（肥料/农药）的计量模型。
 *
 * 背景：原实现把 `applicationRate` 当作"单格用量"，于是同一串数字的物理含义
 * 会随网格尺寸变化——网格改大，实际施用量按面积平方增长，而下游读到的数值不变。
 * 农业领域的正确表达是**单位面积用量**（kg/ha、L/ha、kg/亩），由机具按幅宽换算。
 *
 * 兼容策略：引入显式基准 `applicationRateBasis`：
 * - `per-cell`（默认）：数值即单个网格单元的总量，与历史行为完全一致；
 * - `per-area`：数值是单位面积用量，单元格用量由 `数值 × 单元格面积 / 单位面积` 推导。
 *
 * 这样导出产物（处方波段、GeoJSON 的 fertilizerAmount）仍然只承载"每格用量"，
 * 下游无需改动；同时新的计量方式可以逐条规则启用。
 *
 * 接入状态（截至 2026-11）：
 * - 已接入：`resolveCellAmount` 被 GeoTIFF 处方波段与 GeoJSON 导出使用；
 *   `normalizeApplicationRateBasis/Unit` 被导出与工程快照校验使用；
 *   `summarizeApplicationRates` 被 RightPanel 的规则统计使用；
 *   规则编辑器的基准/单位控件（`APPLICATION_RATE_MODE_OPTIONS` 等）已在
 *   RightPanel 中渲染，`per-area` 可直接在界面上选择。
 *
 * 注：`aad5219` 曾在此处标注「预留 API 尚未接入」，但同日稍后的 `f04e82a`
 * 已把编辑器控件与汇总展示接上，该标注随即过期，故改写而非保留。
 */

import type { RasterClassificationRule } from '@/shared/types/raster';

export type ApplicationRateBasis = 'per-cell' | 'per-area';

export type ApplicationRateUnit = 'per-square-meter' | 'per-hectare' | 'per-mu';

export const DEFAULT_APPLICATION_RATE_BASIS: ApplicationRateBasis = 'per-cell';
export const DEFAULT_APPLICATION_RATE_UNIT: ApplicationRateUnit = 'per-hectare';

/** 每个面积单位对应的平方米数；1 亩 = 2000/3 m² */
export const SQUARE_METERS_PER_UNIT: Record<ApplicationRateUnit, number> = {
  'per-square-meter': 1,
  'per-hectare': 10_000,
  'per-mu': 2000 / 3,
};

const BASIS_VALUES: readonly ApplicationRateBasis[] = ['per-cell', 'per-area'];
const UNIT_VALUES: readonly ApplicationRateUnit[] = [
  'per-square-meter',
  'per-hectare',
  'per-mu',
];

export function isApplicationRateBasis(value: unknown): value is ApplicationRateBasis {
  return typeof value === 'string' && BASIS_VALUES.includes(value as ApplicationRateBasis);
}

export function isApplicationRateUnit(value: unknown): value is ApplicationRateUnit {
  return typeof value === 'string' && UNIT_VALUES.includes(value as ApplicationRateUnit);
}

export function normalizeApplicationRateBasis(value: unknown): ApplicationRateBasis {
  return isApplicationRateBasis(value) ? value : DEFAULT_APPLICATION_RATE_BASIS;
}

export function normalizeApplicationRateUnit(value: unknown): ApplicationRateUnit {
  return isApplicationRateUnit(value) ? value : DEFAULT_APPLICATION_RATE_UNIT;
}

function getUnitSquareMeters(unit: ApplicationRateUnit): number {
  return SQUARE_METERS_PER_UNIT[unit];
}

/**
 * 抹掉二进制浮点噪音（例如 0.1 + 0.2 = 0.30000000000000004），
 * 保留 6 位小数——远高于农业用量的有效精度。
 */
function roundAmount(value: number): number {
  if (!Number.isFinite(value)) {
    return value;
  }

  return Number(value.toFixed(6));
}

export type ApplicationRateInput = Pick<
  RasterClassificationRule,
  'applicationRate' | 'applicationRateBasis' | 'applicationRateUnit'
>;

/**
 * 把一条规则的用量换算为**单个网格单元应施加的量**（导出与统计的统一口径）。
 *
 * - `per-cell`：原样返回；
 * - `per-area`：数值 × 单元格面积 ÷ 单位面积；
 * - 未设置用量或数值非法：返回 null。
 */
export function resolveCellAmount(
  rule: ApplicationRateInput,
  cellAreaM2: number,
): number | null {
  const rate = rule.applicationRate;

  if (rate === null || rate === undefined || !Number.isFinite(rate)) {
    return null;
  }

  if (normalizeApplicationRateBasis(rule.applicationRateBasis) === 'per-cell') {
    return roundAmount(rate);
  }

  if (!Number.isFinite(cellAreaM2) || cellAreaM2 <= 0) {
    return null;
  }

  const unit = normalizeApplicationRateUnit(rule.applicationRateUnit);
  return roundAmount((rate * cellAreaM2) / getUnitSquareMeters(unit));
}

export type ApplicationRatePerRule = {
  matchedCount: number;
  areaM2: number;
  /** 该规则对应的单格用量（未设置用量时为 null） */
  cellAmount: number | null;
  /** 该规则命中的总用量 */
  totalAmount: number;
};

export type ApplicationRateSummary = {
  perRule: ApplicationRatePerRule[];
  totalAreaM2: number;
  totalAmount: number;
};

/**
 * 汇总各规则的命中格数、覆盖面积与总用量。
 * 界面展示与导出统计共用同一份口径，避免两处各算一套。
 * 预留给用量汇总界面，目前尚无生产调用方。
 */
export function summarizeApplicationRates(input: {
  rules: ReadonlyArray<ApplicationRateInput>;
  /** 与 rules 同序的命中格数 */
  matchedCounts: readonly number[];
  cellAreaM2: number;
}): ApplicationRateSummary {
  const { rules, matchedCounts, cellAreaM2 } = input;
  const perRule: ApplicationRatePerRule[] = [];
  let totalAreaM2 = 0;
  let totalAmount = 0;

  rules.forEach((rule, index) => {
    const matchedCount = matchedCounts[index] ?? 0;
    const areaM2 = roundAmount(matchedCount * cellAreaM2);
    const cellAmount = resolveCellAmount(rule, cellAreaM2);
    const ruleTotal = cellAmount === null ? 0 : roundAmount(cellAmount * matchedCount);

    totalAreaM2 = roundAmount(totalAreaM2 + areaM2);
    totalAmount = roundAmount(totalAmount + ruleTotal);

    perRule.push({ matchedCount, areaM2, cellAmount, totalAmount: ruleTotal });
  });

  return { perRule, totalAreaM2, totalAmount };
}
