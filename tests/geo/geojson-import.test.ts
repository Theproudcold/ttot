import { describe, expect, it } from 'vitest';

import { readProjectSnapshotFromGeoJson } from '@/features/project/geojsonProject';
import { exportProjectSnapshot } from '@/features/project/projectSnapshot';
import {
  GEOJSON_PROJECT_MEMBER,
  parseFenceGeoJson,
} from '@/shared/geo/geojsonImport';

const SQUARE: [number, number][] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0],
];

function polygonFeature(ring: [number, number][], extra: Record<string, unknown> = {}) {
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] }, ...extra };
}

describe('parseFenceGeoJson — accepted shapes', () => {
  it('accepts a bare Polygon geometry', () => {
    const result = parseFenceGeoJson({ type: 'Polygon', coordinates: [SQUARE] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rings).toEqual([SQUARE]);
    expect(result.source).toEqual({ geometryType: 'Polygon', featureCount: 1 });
    expect(result.warnings).toEqual([]);
    expect(result.projectMember).toBeNull();
  });

  it('accepts a single Feature', () => {
    const result = parseFenceGeoJson(polygonFeature(SQUARE));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rings).toEqual([SQUARE]);
  });

  it('accepts the FeatureCollection this tool exports for a fence', () => {
    const result = parseFenceGeoJson({
      type: 'FeatureCollection',
      features: [polygonFeature(SQUARE)],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rings).toEqual([SQUARE]);
    expect(result.source?.featureCount).toBe(1);
  });

  it('keeps interior rings (holes)', () => {
    const hole: [number, number][] = [
      [2, 2],
      [4, 2],
      [4, 4],
      [2, 4],
      [2, 2],
    ];
    const result = parseFenceGeoJson({ type: 'Polygon', coordinates: [SQUARE, hole] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rings).toHaveLength(2);
  });

  it('accepts a JSON string as well as an object', () => {
    const result = parseFenceGeoJson(JSON.stringify({ type: 'Polygon', coordinates: [SQUARE] }));

    expect(result.ok).toBe(true);
  });
});

describe('parseFenceGeoJson — repairs and rejects', () => {
  it('closes an open ring and warns', () => {
    const open: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const result = parseFenceGeoJson({ type: 'Polygon', coordinates: [open] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rings?.[0]).toEqual(SQUARE);
    expect(result.warnings[0]).toContain('未闭合');
  });

  it('drops consecutive duplicate points', () => {
    const duplicated: [number, number][] = [
      [0, 0],
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    const result = parseFenceGeoJson({ type: 'Polygon', coordinates: [duplicated] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rings?.[0]).toEqual(SQUARE);
  });

  it('rejects a ring with fewer than three distinct points', () => {
    const degenerate: [number, number][] = [
      [0, 0],
      [10, 0],
      [0, 0],
    ];
    const result = parseFenceGeoJson({ type: 'Polygon', coordinates: [degenerate] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('3 个不同顶点');
  });

  it('rejects non-finite coordinates', () => {
    const result = parseFenceGeoJson({
      type: 'Polygon',
      coordinates: [[[0, 0], ['x', 0], [10, 10], [0, 0]]],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('非法');
  });

  it('rejects non-polygon geometries', () => {
    const result = parseFenceGeoJson({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('不是多边形');
  });

  it('rejects unsupported types and malformed JSON', () => {
    expect(parseFenceGeoJson({ type: 'Point', coordinates: [0, 0] }).ok).toBe(false);
    expect(parseFenceGeoJson('{ not json').ok).toBe(false);
    expect(parseFenceGeoJson(42).ok).toBe(false);
  });

  it('picks the largest polygon from a MultiPolygon', () => {
    const tiny: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ];
    const result = parseFenceGeoJson({ type: 'MultiPolygon', coordinates: [[tiny], [SQUARE]] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 正方形面积 100 > 小方块面积 1
    expect(result.rings?.[0]).toEqual(SQUARE);
    expect(result.warnings[0]).toContain('面积最大的一个');
  });
});

describe('parseFenceGeoJson — grid export vs fence export', () => {
  it('refuses a multi-polygon file without a project member', () => {
    const result = parseFenceGeoJson({
      type: 'FeatureCollection',
      features: [polygonFeature(SQUARE), polygonFeature(SQUARE.map(([x, y]) => [x + 20, y]))],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('网格导出');
    expect(result.errors[0]).toContain(GEOJSON_PROJECT_MEMBER);
  });

  it('accepts a grid export that carries a project member, restoring settings only', () => {
    const snapshot = exportProjectSnapshot({
      sourceFile: null,
      sourceLabel: '未选择文件',
      metadata: null,
      fenceRings: [SQUARE],
      grid: { cellSize: 2, rotation: 10, aggregationMode: 'mean' },
      classification: { layers: [], activeLayerId: null, visibleLayerId: null },
      view: {
        layers: { raster: true, fence: true, grid: true },
        gridRenderSettings: {
          useClassificationColors: true,
          fillColor: '#3388ff',
          fillOpacity: 0.3,
          strokeColor: '#3388ff',
          strokeOpacity: 0.8,
          strokeWidth: 1,
        },
      },
    });

    const result = parseFenceGeoJson({
      type: 'FeatureCollection',
      [GEOJSON_PROJECT_MEMBER]: snapshot,
      features: [polygonFeature(SQUARE), polygonFeature(SQUARE)],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rings).toBeNull();
    expect(result.projectMember).toEqual(snapshot);
  });

  it('reports an empty FeatureCollection clearly', () => {
    const result = parseFenceGeoJson({ type: 'FeatureCollection', features: [] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('没有可用的多边形');
  });
});

describe('parseFenceGeoJson — reprojection', () => {
  const lonLatRing: [number, number][] = [
    [120, 36],
    [120.001, 36],
    [120.001, 36.001],
    [120, 36.001],
    [120, 36],
  ];

  it('does not reproject by default', () => {
    const result = parseFenceGeoJson({ type: 'Polygon', coordinates: [lonLatRing] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rings?.[0][0]).toEqual([120, 36]);
  });

  it('reprojects when explicitly asked', () => {
    const result = parseFenceGeoJson(
      { type: 'Polygon', coordinates: [lonLatRing] },
      { reproject: { from: 'EPSG:4326', to: 'EPSG:4549' } },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [easting, northing] = result.rings?.[0][0] ?? [0, 0];
    // CGCS2000 3 度带 CM120E：中央经线附近东坐标接近 500000
    expect(easting).toBeGreaterThan(400_000);
    expect(easting).toBeLessThan(600_000);
    expect(northing).toBeGreaterThan(3_500_000);
    expect(northing).toBeLessThan(4_500_000);
  });

  it('refuses to reproject from an unknown CRS instead of guessing', () => {
    const result = parseFenceGeoJson(
      { type: 'Polygon', coordinates: [lonLatRing] },
      { reproject: { from: 'EPSG:999999', to: 'EPSG:4549' } },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('缺少坐标系定义');
  });
});

describe('readProjectSnapshotFromGeoJson', () => {
  const snapshot = exportProjectSnapshot({
    sourceFile: null,
    sourceLabel: '未选择文件',
    metadata: null,
    fenceRings: [SQUARE],
    grid: { cellSize: 1, rotation: 0, aggregationMode: 'mean' },
    classification: { layers: [], activeLayerId: null, visibleLayerId: null },
    view: {
      layers: { raster: true, fence: true, grid: true },
      gridRenderSettings: {
        useClassificationColors: true,
        fillColor: '#3388ff',
        fillOpacity: 0.3,
        strokeColor: '#3388ff',
        strokeOpacity: 0.8,
        strokeWidth: 1,
      },
    },
  });

  it('reads a valid member', () => {
    const result = readProjectSnapshotFromGeoJson({ [GEOJSON_PROJECT_MEMBER]: snapshot });

    expect(result.snapshot).toEqual(snapshot);
  });

  it('returns null when the member is absent', () => {
    expect(readProjectSnapshotFromGeoJson({ type: 'Polygon' }).snapshot).toBeNull();
    expect(readProjectSnapshotFromGeoJson(null).snapshot).toBeNull();
  });

  it('reports an unusable member instead of throwing', () => {
    const result = readProjectSnapshotFromGeoJson({ [GEOJSON_PROJECT_MEMBER]: { kind: 'other' } });

    expect(result.snapshot).toBeNull();
    expect(result.warnings[0]).toContain('无法使用');
  });
});
