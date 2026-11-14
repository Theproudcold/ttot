import { hexToRgb, hexToRgba, interpolateHexColors } from './rasterColor';
import { isValidRasterSample } from './rasterPreview';
import { PREVIEW_RULE_SEMANTICS, findRuleMatch } from './classificationRuleMatching';
import type {
  RasterClassificationLayer,
  RasterClassificationBreak,
  RasterClassificationRule,
  RasterGradientStop,
  RasterLayerMatchResult,
  RasterRenderSettings,
  RasterValueRange,
} from '@/shared/types/raster';

const DEFAULT_CLASSIFICATION_COLORS = [
  '#f5f5f4',
  '#e8e8e6',
  '#d9d9d6',
  '#bdbdb8',
  '#9f9f98',
  '#73736d',
  '#474743',
  '#171717',
];

const DEFAULT_NDVI_GRADIENT_STOPS = [
  { value: -1, color: '#8b1e3f', label: '低植被' },
  { value: 0, color: '#d7c98b', label: '裸地' },
  { value: 0.4, color: '#7fbf3f', label: '中等植被' },
  { value: 0.7, color: '#1f7a1f', label: '高植被' },
  { value: 1, color: '#0b3d0b', label: '极高植被' },
] satisfies readonly [RasterGradientStop, ...RasterGradientStop[]];

export type RasterClassificationLegendItem = {
  color: string;
  label: string;
};

export type RasterClassificationLegendData = {
  mode: RasterClassificationLayer['mode'];
  items: RasterClassificationLegendItem[];
  gradientCss: string | null;
};

function countDecimals(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const normalized = value.toString().toLowerCase();
  if (normalized.includes('e-')) {
    const [, exponent] = normalized.split('e-');
    return Number.parseInt(exponent ?? '0', 10) || 0;
  }

  const decimalPart = normalized.split('.')[1];
  return decimalPart ? decimalPart.length : 0;
}

function roundToPrecision(value: number, decimals: number): number {
  const factor = 10 ** Math.max(0, decimals);
  return Math.round(value * factor) / factor;
}

function formatRangeValue(value: number, decimals: number): string {
  return value.toFixed(Math.max(2, decimals));
}

function cloneGradientStops(
  [firstStop, ...restStops]: readonly [RasterGradientStop, ...RasterGradientStop[]],
): [RasterGradientStop, ...RasterGradientStop[]] {
  return [
    { ...firstStop },
    ...restStops.map((stop) => ({ ...stop })),
  ];
}

function getGradientStopPercentages(
  [firstStop, ...restStops]: readonly [RasterGradientStop, ...RasterGradientStop[]],
): number[] {
  const stops = [firstStop, ...restStops];
  const minValue = stops[0].value;
  const maxValue = stops[stops.length - 1].value;
  const valueSpan = maxValue - minValue;

  if (valueSpan <= 0) {
    return stops.map((_, index) => {
      if (stops.length === 1) {
        return 100;
      }

      return (index / (stops.length - 1)) * 100;
    });
  }

  return stops.map((stop) => ((stop.value - minValue) / valueSpan) * 100);
}

function getClassificationColor(index: number, total: number, colors: string[]): string {
  if (total <= 1) {
    return colors.at(Math.floor(colors.length / 2)) ?? colors[0] ?? '#777777';
  }

  const paletteIndex = Math.round((index / (total - 1)) * (colors.length - 1));
  return colors[Math.min(colors.length - 1, Math.max(0, paletteIndex))] ?? '#777777';
}

/**
 * 在规则列表中查找第一个匹配给定值的分类规则。
 *
 * 语义为**左闭右开** `[min, max)`，与预览/图例一致；
 * 导出侧使用左闭右闭，差异集中记录在 `classificationRuleMatching.ts`。
 */
export function findMatchingClassificationRule(
  value: number,
  rules: RasterClassificationRule[],
): RasterClassificationRule | null {
  return findRuleMatch(rules, value, PREVIEW_RULE_SEMANTICS)?.rule ?? null;
}

/**
 * 根据分类图层构建图例数据，支持规则模式与渐变模式。
 */
export function buildRasterClassificationLegendData(
  layer: RasterClassificationLayer,
): RasterClassificationLegendData {
  if (layer.mode === 'rules') {
    return {
      mode: layer.mode,
      items: layer.rules.map((rule) => ({
        color: rule.color,
        label: rule.label,
      })),
      gradientCss: null,
    };
  }

  const percentages = getGradientStopPercentages(layer.gradientStops);
  const stops = layer.gradientStops.map((stop, index) => `${stop.color} ${percentages[index].toFixed(2)}%`);

  return {
    mode: layer.mode,
    items: layer.gradientStops.map((stop) => ({
      color: stop.color,
      label: stop.label,
    })),
    gradientCss: `linear-gradient(90deg, ${stops.join(', ')})`,
  };
}

/**
 * 构建默认的 NDVI 渐变分类图层。
 */
export function buildDefaultNdviClassificationLayer(): RasterClassificationLayer {
  return {
    id: 'ndvi-default',
    label: 'NDVI 默认分级',
    mode: 'gradient',
    noDataColor: '#00000000',
    gradientStops: cloneGradientStops(DEFAULT_NDVI_GRADIENT_STOPS),
    rules: [],
  };
}

/**
 * 为给定值在分类图层中查找匹配结果。
 * 规则模式返回匹配规则；渐变模式在色标间进行线性插值。
 */
export function findRasterClassificationMatch(
  value: number,
  layer: RasterClassificationLayer,
): RasterLayerMatchResult | null {
  if (!Number.isFinite(value)) {
    return null;
  }

  if (layer.mode === 'rules') {
    const matchedRule = findMatchingClassificationRule(value, layer.rules);
    if (!matchedRule) {
      return null;
    }

    return {
      color: matchedRule.color,
      label: matchedRule.label,
      matchedRule,
    };
  }

  const stops = layer.gradientStops;
  if (stops.length === 0) {
    return null;
  }

  const exactStop = stops.find((stop) => value === stop.value);
  if (exactStop) {
    return {
      color: exactStop.color,
      label: exactStop.label,
      matchedRule: null,
    };
  }

  if (value <= stops[0].value) {
    return {
      color: stops[0].color,
      label: stops[0].label,
      matchedRule: null,
    };
  }

  const lastStop = stops[stops.length - 1];
  if (value >= lastStop.value) {
    return {
      color: lastStop.color,
      label: lastStop.label,
      matchedRule: null,
    };
  }

  for (let index = 0; index < stops.length - 1; index += 1) {
    const currentStop = stops[index];
    const nextStop = stops[index + 1];

    if (value < currentStop.value || value > nextStop.value) {
      continue;
    }

    const ratio = (value - currentStop.value) / (nextStop.value - currentStop.value);
    return {
      color: interpolateHexColors(currentStop.color, nextStop.color, ratio),
      label: `${currentStop.label} ~ ${nextStop.label}`,
      matchedRule: null,
    };
  }

  return {
    color: lastStop.color,
    label: lastStop.label,
    matchedRule: null,
  };
}

/**
 * 根据数值范围和渲染设置构建等距分类断点列表。
 */
export function buildClassificationBreaks(
  range: RasterValueRange | null | undefined,
  settings: RasterRenderSettings,
  colors: string[] = DEFAULT_CLASSIFICATION_COLORS,
): RasterClassificationBreak[] {
  if (!range) {
    return [];
  }

  const step = settings.step > 0 ? settings.step : 0.2;
  const decimals = countDecimals(step);
  const min = settings.min ?? Math.floor(range.min / step) * step;
  const max = settings.max ?? Math.ceil(range.max / step) * step;
  const safeMax = max <= min ? min + step : max;
  const total = Math.max(1, Math.ceil((safeMax - min) / step));

  return Array.from({ length: total }, (_, index) => {
    const start = roundToPrecision(min + index * step, decimals + 4);
    const end =
      index === total - 1
        ? roundToPrecision(safeMax, decimals + 4)
        : roundToPrecision(Math.min(safeMax, min + (index + 1) * step), decimals + 4);

    return {
      min: start,
      max: end,
      color: getClassificationColor(index, total, colors),
      label: `${formatRangeValue(start, decimals)} ~ ${formatRangeValue(end, decimals)}`,
    };
  });
}

/**
 * 在分类断点列表中查找包含指定值的断点。
 */
export function findClassificationBreakForValue(
  value: number,
  breaks: RasterClassificationBreak[],
): RasterClassificationBreak | null {
  if (!Number.isFinite(value) || breaks.length === 0) {
    return null;
  }

  if (value <= breaks[0].min) {
    return breaks[0];
  }

  const lastBreak = breaks[breaks.length - 1];
  if (value >= lastBreak.max) {
    return lastBreak;
  }

  for (const currentBreak of breaks) {
    if (value >= currentBreak.min && value < currentBreak.max) {
      return currentBreak;
    }
  }

  return lastBreak;
}

/**
 * 使用分类断点将单波段采样数据渲染为分类 RGBA 图像。
 */
export function buildClassifiedPreviewRgba(
  samples: ArrayLike<number>,
  width: number,
  height: number,
  breaks: RasterClassificationBreak[],
  noDataValue: number | null,
): Uint8ClampedArray {
  const pixelCount = width * height;
  const rgba = new Uint8ClampedArray(pixelCount * 4);

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const value = samples[pixelIndex] ?? Number.NaN;
    const rgbaOffset = pixelIndex * 4;

    if (!isValidRasterSample(value, noDataValue)) {
      rgba[rgbaOffset + 3] = 0;
      continue;
    }

    const matchedBreak = findClassificationBreakForValue(value, breaks);
    if (!matchedBreak) {
      rgba[rgbaOffset + 3] = 0;
      continue;
    }

    const [red, green, blue] = hexToRgb(matchedBreak.color);
    rgba[rgbaOffset] = red;
    rgba[rgbaOffset + 1] = green;
    rgba[rgbaOffset + 2] = blue;
    rgba[rgbaOffset + 3] = 255;
  }

  return rgba;
}

/**
 * 使用分类图层（规则或渐变）将单波段采样数据渲染为分类 RGBA 图像。
 */
export function buildRasterClassificationPreviewRgba(
  samples: ArrayLike<number>,
  width: number,
  height: number,
  layer: RasterClassificationLayer,
  noDataValue: number | null,
): Uint8ClampedArray {
  const pixelCount = width * height;
  const rgba = new Uint8ClampedArray(pixelCount * 4);

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const value = samples[pixelIndex] ?? Number.NaN;
    const rgbaOffset = pixelIndex * 4;

    if (!isValidRasterSample(value, noDataValue)) {
      const [red, green, blue, alpha] = hexToRgba(layer.noDataColor);
      rgba[rgbaOffset] = red;
      rgba[rgbaOffset + 1] = green;
      rgba[rgbaOffset + 2] = blue;
      rgba[rgbaOffset + 3] = alpha;
      continue;
    }

    const match = findRasterClassificationMatch(value, layer);
    if (!match) {
      rgba[rgbaOffset + 3] = 0;
      continue;
    }

    const [red, green, blue] = hexToRgb(match.color);
    rgba[rgbaOffset] = red;
    rgba[rgbaOffset + 1] = green;
    rgba[rgbaOffset + 2] = blue;
    rgba[rgbaOffset + 3] = 255;
  }

  return rgba;
}
