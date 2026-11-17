import { hexToRgb, hexToRgba, interpolateHexColors } from './rasterColor';
import { isValidRasterSample } from './rasterPreview';
import { findRuleMatch } from './classificationRuleMatching';
import type {
  RasterClassificationLayer,
  RasterClassificationRule,
  RasterGradientStop,
  RasterLayerMatchResult,
} from '@/shared/types/raster';

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

/**
 * 在规则列表中查找第一个匹配给定值的分类规则。
 *
 * 语义为**左闭右闭** `[min, max]`，全仓统一，见 `classificationRuleMatching.ts`。
 */
export function findMatchingClassificationRule(
  value: number,
  rules: RasterClassificationRule[],
): RasterClassificationRule | null {
  return findRuleMatch(rules, value)?.rule ?? null;
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
