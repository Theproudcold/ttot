import { getDegreeToMeterScale } from '@/shared/geo/crs';
import type { RasterMetadata, RasterRuleClassificationLayer, RasterClassificationMode } from '@/shared/types/raster';

/**
 * 根据影像坐标显示模式返回合适的小数位数。
 * 地理坐标保留 6 位，投影坐标保留 2 位。
 */
export function getCoordinateDecimals(metadata: RasterMetadata | null | undefined): number {
  return metadata?.coordinateDisplayMode === 'geographic' ? 6 : 2;
}

/**
 * 将影像边界框格式化为逗号分隔的字符串。
 */
export function formatSourceExtent(metadata: RasterMetadata | null | undefined): string {
  if (!metadata) {
    return '--';
  }

  const decimals = getCoordinateDecimals(metadata);
  return metadata.boundingBox.map((value) => value.toFixed(decimals)).join(', ');
}

/**
 * 将影像的物理尺寸格式化为 "宽 x 高" 的字符串，单位为米。
 */
export function formatRasterPhysicalSize(metadata: RasterMetadata | null | undefined): string {
  if (!metadata) {
    return '--';
  }

  return `${metadata.metricWidth.toFixed(2)}m x ${metadata.metricHeight.toFixed(2)}m`;
}

/**
 * 计算并格式化网格单元大小相对于影像宽高的比例。
 */
export function formatGridRatio(
  cellSize: number,
  metadata: RasterMetadata | null | undefined,
): string {
  if (!metadata || cellSize <= 0) {
    return '--';
  }

  const width = metadata.metricWidth;
  const height = metadata.metricHeight;

  if (width <= 0 || height <= 0) {
    return '--';
  }

  const widthRatio = (cellSize / width) * 100;
  const heightRatio = (cellSize / height) * 100;
  return `${widthRatio.toFixed(1)}% / ${heightRatio.toFixed(1)}%`;
}

/**
 * 将围栏面积格式化为带单位的字符串。
 * 若为地理坐标，先根据纬度换算为平方米。
 */
export function formatFenceArea(
  area: number | null,
  bbox: [number, number, number, number] | null | undefined,
  isGeographic: boolean,
): string {
  if (area === null) {
    return '--';
  }

  if (isGeographic && bbox) {
    const scale = getDegreeToMeterScale((bbox[1] + bbox[3]) / 2);
    return `${(area * scale.scaleX * scale.scaleY).toFixed(2)} m²`;
  }

  return `${area.toFixed(2)} m²`;
}

/**
 * 将围栏边界框格式化为逗号分隔的字符串，保留 2 位小数。
 */
export function formatFenceBbox(bbox: [number, number, number, number] | null): string {
  if (!bbox) {
    return '--';
  }

  return bbox.map((value) => value.toFixed(2)).join(', ');
}

/**
 * 将数值格式化为中文_locale的两位小数字符串。
 * 无效值显示为 "--"。
 */
export function formatMetricNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return '--';
  }

  // 清洗常见的浮点精度噪音（如 0.1 + 0.2 = 0.30000000000000004）
  const cleaned = parseFloat(value.toFixed(12));

  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: 2,
  }).format(cleaned);
}

/**
 * 将分类模式枚举转换为中文显示文本。
 */
export function formatClassificationMode(mode: RasterClassificationMode): string {
  return mode === 'gradient' ? '渐变' : '规则';
}

/**
 * 生成不重复的分类方案 ID。
 */
export function createClassificationLayerId(existingIds: string[]): string {
  let index = 1;
  let nextId = `classification-rules-${index}`;

  while (existingIds.includes(nextId)) {
    index += 1;
    nextId = `classification-rules-${index}`;
  }

  return nextId;
}

/**
 * 生成不重复的分类方案标签名称。
 */
export function createClassificationLayerLabel(existingLabels: string[]): string {
  let index = 1;
  let nextLabel = `自定义方案 ${index}`;

  while (existingLabels.includes(nextLabel)) {
    index += 1;
    nextLabel = `自定义方案 ${index}`;
  }

  return nextLabel;
}

/**
 * 基于现有 ID 和标签列表，构建一个默认的规则分类图层。
 */
export function buildNewRulesClassificationLayer(
  existingIds: string[],
  existingLabels: string[],
): RasterRuleClassificationLayer & { visible: boolean } {
  return {
    id: createClassificationLayerId(existingIds),
    label: createClassificationLayerLabel(existingLabels),
    mode: 'rules',
    noDataColor: '#00000000',
    gradientStops: [],
    rules: [
      {
        min: -1,
        max: 0,
        color: '#cccccc',
        label: '规则 1',
        applicationRate: null,
      },
    ],
    visible: true,
  };
}

/**
 * 不可变地更新规则列表中的指定规则。
 */
export function updateRuleTuple(
  rules: RasterRuleClassificationLayer['rules'],
  ruleIndex: number,
  updater: (rule: RasterRuleClassificationLayer['rules'][number]) => RasterRuleClassificationLayer['rules'][number],
): RasterRuleClassificationLayer['rules'] {
  const [firstRule, ...restRules] = rules;

  return [
    ruleIndex === 0 ? updater(firstRule) : firstRule,
    ...restRules.map((rule, index) => (index + 1 === ruleIndex ? updater(rule) : rule)),
  ] as RasterRuleClassificationLayer['rules'];
}
