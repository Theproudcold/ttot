import { getDegreeToMeterScale } from '@/shared/geo/crs';
import {
  normalizeApplicationRateBasis,
  normalizeApplicationRateUnit,
  type ApplicationRateUnit,
} from '@/shared/geo/applicationRate';
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
function createClassificationLayerId(existingIds: string[]): string {
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
function createClassificationLayerLabel(existingLabels: string[]): string {
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

// ---------------------------------------------------------------------------
// 施用量计量方式
// ---------------------------------------------------------------------------

/** 界面上可选的四档计量方式：每格，或三种单位面积 */
export type ApplicationRateMode = 'per-cell' | ApplicationRateUnit;

export const APPLICATION_RATE_MODE_OPTIONS: ReadonlyArray<{
  value: ApplicationRateMode;
  label: string;
}> = [
  { value: 'per-cell', label: '每格用量' },
  { value: 'per-mu', label: '每亩' },
  { value: 'per-hectare', label: '每公顷' },
  { value: 'per-square-meter', label: '每平方米' },
];

/** 1 亩 = 2000/3 m² */
const SQUARE_METERS_PER_MU = 2000 / 3;

/** 从规则读回界面上的计量方式 */
export function resolveApplicationRateMode(rule: {
  applicationRateBasis?: 'per-cell' | 'per-area';
  applicationRateUnit?: ApplicationRateUnit;
}): ApplicationRateMode {
  if (normalizeApplicationRateBasis(rule.applicationRateBasis) === 'per-cell') {
    return 'per-cell';
  }

  return normalizeApplicationRateUnit(rule.applicationRateUnit);
}

/** 字段标题：让"这个数字是什么量"写在标签里，而不是靠用户猜 */
export function describeApplicationRateMode(mode: ApplicationRateMode): string {
  switch (mode) {
    case 'per-cell':
      return '单格用量';
    case 'per-mu':
      return '每亩用量';
    case 'per-hectare':
      return '每公顷用量';
    case 'per-square-meter':
      return '每平方米用量';
  }
}

/**
 * 写入计量方式。切到"每格"时只改基准、保留单位，
 * 这样用户来回切换不会丢掉之前选的面积单位。
 */
export function withApplicationRateMode<
  T extends {
    applicationRateBasis?: 'per-cell' | 'per-area';
    applicationRateUnit?: ApplicationRateUnit;
  },
>(rule: T, mode: ApplicationRateMode): T {
  if (mode === 'per-cell') {
    return { ...rule, applicationRateBasis: 'per-cell' };
  }

  return { ...rule, applicationRateBasis: 'per-area', applicationRateUnit: mode };
}

/** 面积同时给出平方米与亩，避免用户自己换算 */
export function formatAreaWithMu(areaM2: number): string {
  if (!Number.isFinite(areaM2) || areaM2 <= 0) {
    return '--';
  }

  const mu = areaM2 / SQUARE_METERS_PER_MU;
  // 小面积时亩数很小（1 m² ≈ 0.0015 亩），沿用两位小数会显示成"约 0 亩"
  const muText = mu >= 1 ? formatMetricNumber(mu) : formatCellAmount(mu);

  return `${formatMetricNumber(areaM2)} m²（约 ${muText} 亩）`;
}

/**
 * 每格用量的格式化。
 * 单位面积速率换算到小网格后数值可能很小（每亩 4kg 落在 1m 网格上是 0.006），
 * 沿用统计口径的两位小数会把它显示成 0.01，因此这里保留 3 位有效数字。
 */
export function formatCellAmount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '--';
  }

  const cleaned = Number.parseFloat(value.toPrecision(3));

  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 }).format(cleaned);
}
