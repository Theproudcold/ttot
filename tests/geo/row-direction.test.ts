import { describe, expect, it } from 'vitest';

import { createMetricTransform } from '@/shared/geo/crs';
import {
  axialDeltaDegrees,
  computeFenceEdges,
  describeRowDirection,
  normalizeAzimuth,
  resolveGridRotationForRowDirection,
  rowDirectionToGridRotation,
  suggestRowDirection,
  toAxialDegrees,
} from '@/shared/geo/rowDirection';

/** 东西向长条：100m（东西）× 20m（南北） */
const EAST_WEST_FIELD: [number, number][][] = [
  [
    [0, 0],
    [100, 0],
    [100, 20],
    [0, 20],
    [0, 0],
  ],
];

/** 南北向长条：20m × 100m */
const NORTH_SOUTH_FIELD: [number, number][][] = [
  [
    [0, 0],
    [20, 0],
    [20, 100],
    [0, 100],
    [0, 0],
  ],
];

describe('angle helpers', () => {
  it('normalizes azimuths into [0, 360)', () => {
    expect(normalizeAzimuth(0)).toBe(0);
    expect(normalizeAzimuth(360)).toBe(0);
    expect(normalizeAzimuth(-90)).toBe(270);
    expect(normalizeAzimuth(450)).toBe(90);
    expect(normalizeAzimuth(Number.NaN)).toBe(0);
  });

  it('collapses to an undirected row direction in [0, 180)', () => {
    // 0° 与 180° 是同一组行
    expect(toAxialDegrees(0)).toBe(0);
    expect(toAxialDegrees(180)).toBe(0);
    expect(toAxialDegrees(270)).toBe(90);
    expect(toAxialDegrees(90)).toBe(90);
  });

  it('measures the smallest angle between two row directions', () => {
    expect(axialDeltaDegrees(10, 20)).toBe(10);
    expect(axialDeltaDegrees(175, 5)).toBe(10);
    expect(axialDeltaDegrees(0, 90)).toBe(90);
    expect(axialDeltaDegrees(90, 0)).toBe(90);
  });

  it('maps a row direction onto the grid rotation', () => {
    // 行向正东 = 网格不旋转（未旋转的行沿 X 轴）
    expect(rowDirectionToGridRotation(90)).toBe(0);
    // 行向正北 = 逆时针 90°（等价 270°）
    expect(rowDirectionToGridRotation(0)).toBe(270);
    expect(rowDirectionToGridRotation(45)).toBe(315);
    expect(rowDirectionToGridRotation(180)).toBe(90);
  });

  it('returns null rotation for unusable input', () => {
    expect(resolveGridRotationForRowDirection(null)).toBeNull();
    expect(resolveGridRotationForRowDirection(undefined)).toBeNull();
    expect(resolveGridRotationForRowDirection(Number.NaN)).toBeNull();
    expect(resolveGridRotationForRowDirection(90)).toBe(0);
  });

  it('describes directions in Chinese', () => {
    expect(describeRowDirection(0)).toBe('南北向');
    expect(describeRowDirection(90)).toBe('东西向');
    expect(describeRowDirection(45)).toBe('东北—西南向');
    expect(describeRowDirection(135)).toBe('西北—东南向');
  });
});

describe('computeFenceEdges', () => {
  it('measures length and azimuth in the metric plane', () => {
    const edges = computeFenceEdges({ rings: EAST_WEST_FIELD });

    expect(edges).toHaveLength(4);
    expect(edges[0].length).toBeCloseTo(100, 6);
    expect(edges[0].azimuthDeg).toBeCloseTo(90, 6); // 正东
    expect(edges[0].axialDeg).toBeCloseTo(90, 6);

    expect(edges[1].length).toBeCloseTo(20, 6);
    expect(edges[1].azimuthDeg).toBeCloseTo(0, 6); // 正北

    // 返回方向（自东向西）同样是东西向
    expect(edges[2].length).toBeCloseTo(100, 6);
    expect(edges[2].azimuthDeg).toBeCloseTo(270, 6);
    expect(edges[2].axialDeg).toBeCloseTo(90, 6);
  });

  it('ignores holes and degenerate edges', () => {
    const edges = computeFenceEdges({
      rings: [
        [
          [0, 0],
          [10, 0],
          [10, 0], // 重复点 → 零长边
          [10, 10],
          [0, 10],
          [0, 0],
        ],
        [
          [2, 2],
          [8, 2],
          [8, 8],
          [2, 8],
          [2, 2],
        ],
      ],
    });

    expect(edges).toHaveLength(4);
    expect(edges.every((edge) => edge.length >= 10)).toBe(true);
  });

  it('returns nothing when the ring has no usable edge', () => {
    expect(computeFenceEdges({ rings: [] })).toEqual([]);
    expect(computeFenceEdges({ rings: [[[0, 0], [0, 0]]] })).toEqual([]);
  });
});

describe('suggestRowDirection', () => {
  it('aligns rows with the longest edge of an east-west field', () => {
    const suggestion = suggestRowDirection({ rings: EAST_WEST_FIELD });

    expect(suggestion).not.toBeNull();
    if (!suggestion) return;

    expect(suggestion.azimuthDeg).toBeCloseTo(90, 6);
    expect(suggestion.gridRotationDeg).toBe(0);
    expect(suggestion.basis.length).toBeCloseTo(100, 6);
    expect(suggestion.isAmbiguous).toBe(false);
    // 短边与建议方向成 90°，正好是掉头方向
    const shortEdge = suggestion.edges.find((edge) => edge.length < 50);
    expect(shortEdge?.deltaFromSuggestionDeg).toBeCloseTo(90, 6);
  });

  it('aligns rows with the longest edge of a north-south field', () => {
    const suggestion = suggestRowDirection({ rings: NORTH_SOUTH_FIELD });

    expect(suggestion?.azimuthDeg).toBeCloseTo(0, 6);
    expect(suggestion?.gridRotationDeg).toBe(270);
  });

  it('handles a diagonal long edge', () => {
    const suggestion = suggestRowDirection({
      rings: [
        [
          [0, 0],
          [100, 100],
          [100, 110],
          [0, 10],
          [0, 0],
        ],
      ],
    });

    expect(suggestion?.azimuthDeg).toBeCloseTo(45, 6);
    expect(suggestion?.gridRotationDeg).toBe(315);
  });

  it('flags near-square fields as ambiguous', () => {
    const suggestion = suggestRowDirection({
      rings: [
        [
          [0, 0],
          [100, 0],
          [100, 95],
          [0, 95],
          [0, 0],
        ],
      ],
    });

    expect(suggestion?.isAmbiguous).toBe(true);
  });

  it('returns null when there is no usable edge', () => {
    expect(suggestRowDirection({ rings: [] })).toBeNull();
    expect(suggestRowDirection({ rings: [[[5, 5], [5, 5], [5, 5]]] })).toBeNull();
  });
});

describe('geographic fences', () => {
  // 纬度 60° 处经度被压缩约一半：按"度"比较与按"米"比较会得出相反结论
  const longitudeSquashedField: [number, number][][] = [
    [
      [10.1, 60.1],
      [10.102, 60.1],
      [10.102, 60.1015],
      [10.1, 60.1015],
      [10.1, 60.1],
    ],
  ];

  it('would pick the wrong side if raw degrees were used', () => {
    const raw = suggestRowDirection({ rings: longitudeSquashedField });

    // 0.002°（经度）> 0.0015°（纬度）→ 按度会比较出"东西向"
    expect(raw?.azimuthDeg).toBeCloseTo(90, 6);
  });

  it('picks the right side once converted to the metric plane', () => {
    const metricTransform = createMetricTransform({
      crsCode: 'EPSG:4326',
      boundingBox: [10.1, 60.1, 10.102, 60.1015],
    });

    const suggested = suggestRowDirection({ rings: longitudeSquashedField, metricTransform });

    // 换算成米后：东西 ≈ 111m，南北 ≈ 167m → 应推荐南北向
    expect(suggested?.azimuthDeg).toBeCloseTo(0, 6);
    expect(suggested?.gridRotationDeg).toBe(270);
    expect(suggested?.basis.length).toBeGreaterThan(150);
  });
});
