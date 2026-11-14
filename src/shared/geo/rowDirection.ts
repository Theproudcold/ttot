/**
 * 农机行向（作业方向）对齐。
 *
 * 为什么需要它：变量施肥/喷药是按"行"走的，机具在田块里掉头次数直接决定油耗与工时。
 * 行向应当沿着田块的**最长边**，这也是 NDVItoTaskmap 等工具的通行做法
 * （"North-South 按钮或按最长边自动推荐"）。
 *
 * 两个容易搞错的点，本模块把它们分开表达：
 * 1. **行向是无向的**：0° 与 180° 是同一组行，`[0, 360)` 必须折算到 `[0, 180)`，
 *    否则"东西向"会被算成两个不同方向、比较时出现 180° 的假差异。
 * 2. **方位角 ≠ 网格旋转角**：方位角以正北为 0、顺时针为正；而本工具的网格旋转
 *    是在度量平面（X = 东，Y = 北）里的逆时针旋转。两者相差 90°，
 *    直接把手测方位角塞进 `rotation` 会让行向偏 90°。
 */

import type { MetricTransform } from '@/shared/geo/crs';
import type { FencePosition, FenceRings } from '@/shared/types/fence';

/** 认定为退化边的长度阈值（米） */
const MIN_EDGE_LENGTH = 1e-9;
/** 最长边与次长边的长度比低于该值时，认为地块接近方形、行向收益有限 */
const AMBIGUOUS_LENGTH_RATIO = 0.9;
/** 方向夹角小于该值视为同一组行（矩形对边方向相同，不应被当成"另一个方向"） */
const AMBIGUOUS_DIRECTION_DELTA_DEG = 10;

export type RowDirectionEdge = {
  /** 边长（度量平面，单位米） */
  length: number;
  /** 边的方位角，[0, 360)，正北为 0、顺时针为正 */
  azimuthDeg: number;
  /** 折算为无向行向，[0, 180) */
  axialDeg: number;
  /** 与最终建议行向的夹角，[0, 90] */
  deltaFromSuggestionDeg: number;
};

export type RowDirectionSuggestion = {
  /** 建议行向（无向），[0, 180) */
  azimuthDeg: number;
  /** 可直接写入 gridStore.rotation 的网格旋转角，[0, 360) */
  gridRotationDeg: number;
  /** 作为依据的最长边 */
  basis: RowDirectionEdge & { from: FencePosition; to: FencePosition };
  /** 全部候选边，便于界面解释"为什么建议这个方向" */
  edges: Array<RowDirectionEdge & { from: FencePosition; to: FencePosition }>;
  /** 地块接近方形时为 true——此时换行向收益有限，界面应提示而非强制推荐 */
  isAmbiguous: boolean;
};

function toDegrees(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** 归一化到 [0, 360) */
export function normalizeAzimuth(deg: number): number {
  if (!Number.isFinite(deg)) {
    return 0;
  }

  return ((deg % 360) + 360) % 360;
}

/** 折算为无向行向 [0, 180) */
export function toAxialDegrees(deg: number): number {
  return normalizeAzimuth(deg) % 180;
}

/** 两个无向方向之间的最小夹角，[0, 90] */
export function axialDeltaDegrees(a: number, b: number): number {
  const delta = Math.abs(toAxialDegrees(a) - toAxialDegrees(b)) % 180;
  return delta > 90 ? 180 - delta : delta;
}

/**
 * 行向（无向方位角）→ 网格旋转角。
 *
 * 网格未旋转时，行沿 X 轴即方位角 90°（正东）；度量平面内逆时针旋转 φ 后
 * 行向变为 `90° + φ`。要求它等于目标方位角 θ，故 `φ = θ - 90`。
 */
export function rowDirectionToGridRotation(azimuthDeg: number): number {
  return normalizeAzimuth(normalizeAzimuth(azimuthDeg) - 90);
}

type FenceEdge = RowDirectionEdge & { from: FencePosition; to: FencePosition };

/**
 * 计算外环各边的长度与方位角。
 * 只取外环——内环（洞）不决定作业行向；洞挖掉的部分由网格裁剪单独处理。
 */
export function computeFenceEdges(input: {
  rings: FenceRings;
  metricTransform?: MetricTransform | null;
}): FenceEdge[] {
  const { rings, metricTransform } = input;
  const outerRing = rings[0] ?? [];
  const toPlane = metricTransform ? metricTransform.toMetric : (point: FencePosition) => point;

  const edges: FenceEdge[] = [];

  for (let index = 0; index < outerRing.length - 1; index += 1) {
    const from = toPlane(outerRing[index]);
    const to = toPlane(outerRing[index + 1]);
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const length = Math.hypot(dx, dy);

    if (!Number.isFinite(length) || length < MIN_EDGE_LENGTH) {
      continue;
    }

    const azimuthDeg = normalizeAzimuth(toDegrees(Math.atan2(dx, dy)));

    edges.push({
      from: outerRing[index],
      to: outerRing[index + 1],
      length,
      azimuthDeg,
      axialDeg: toAxialDegrees(azimuthDeg),
      deltaFromSuggestionDeg: 0,
    });
  }

  return edges;
}

/**
 * 按最长边推荐作业行向。
 *
 * @returns 边数不足或全部退化时返回 null
 */
export function suggestRowDirection(input: {
  rings: FenceRings;
  metricTransform?: MetricTransform | null;
}): RowDirectionSuggestion | null {
  const edges = computeFenceEdges(input);

  if (edges.length === 0) {
    return null;
  }

  const sorted = [...edges].sort((a, b) => b.length - a.length);
  const basis = sorted[0];
  const azimuthDeg = basis.axialDeg;

  const annotated = edges.map((edge) => ({
    ...edge,
    deltaFromSuggestionDeg: axialDeltaDegrees(edge.axialDeg, azimuthDeg),
  }));

  const annotatedBasis = annotated.find(
    (edge) => edge.from === basis.from && edge.to === basis.to,
  ) ?? { ...basis, deltaFromSuggestionDeg: 0 };

  const isAmbiguous = (() => {
    // 必须找"另一个方向"的最长边：矩形两条长边方向相同，比较原始次长边会永远误报
    const alternative = sorted.find(
      (edge) => axialDeltaDegrees(edge.axialDeg, azimuthDeg) > AMBIGUOUS_DIRECTION_DELTA_DEG,
    );

    return Boolean(alternative && alternative.length >= sorted[0].length * AMBIGUOUS_LENGTH_RATIO);
  })();

  return {
    azimuthDeg,
    gridRotationDeg: rowDirectionToGridRotation(azimuthDeg),
    basis: annotatedBasis,
    edges: annotated,
    isAmbiguous,
  };
}

/**
 * 把行向换算成网格旋转角，供界面"按行向对齐"按钮直接使用。
 * 传入 null 时返回 null，便于直接写进状态。
 */
export function resolveGridRotationForRowDirection(
  azimuthDeg: number | null | undefined,
): number | null {
  if (azimuthDeg === null || azimuthDeg === undefined || !Number.isFinite(azimuthDeg)) {
    return null;
  }

  return rowDirectionToGridRotation(azimuthDeg);
}

/** 供界面显示：把无向行向描述成中文方位 */
export function describeRowDirection(azimuthDeg: number): string {
  const axial = toAxialDegrees(azimuthDeg);

  if (axial < 22.5 || axial >= 157.5) {
    return '南北向';
  }

  if (axial < 67.5) {
    return '东北—西南向';
  }

  if (axial < 112.5) {
    return '东西向';
  }

  return '西北—东南向';
}
