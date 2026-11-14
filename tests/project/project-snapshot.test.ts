import { beforeEach, describe, expect, it } from 'vitest';

import { createIdentityMetricTransform } from '@/shared/geo/crs';
import { useFenceStore } from '@/features/fence/fenceStore';
import { useGridStore } from '@/features/grid/gridStore';
import { useMapUiStore } from '@/features/map/mapUiStore';
import { applyProjectSnapshot } from '@/features/project/applyProjectSnapshot';
import {
  EMBEDDED_SNAPSHOT_PREFIX,
  buildRestorePlan,
  compareFingerprint,
  decodeEmbeddedSnapshot,
  encodeEmbeddedSnapshot,
  exportProjectSnapshot,
  normalizeRotation,
  parseProjectSnapshot,
  serializeProjectSnapshot,
  toStorePatches,
  validateProjectSnapshot,
  type ClassificationLayerState,
  type ExportProjectSnapshotInput,
  type ProjectSnapshotV1,
} from '@/features/project/projectSnapshot';
import type { RasterMetadata } from '@/shared/types/raster';

const FENCE_RINGS: ExportProjectSnapshotInput['fenceRings'] = [
  [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ],
];

const RULES_LAYER: ClassificationLayerState = {
  id: 'rules-a',
  label: '规则方案',
  noDataColor: '#00000000',
  visible: true,
  mode: 'rules',
  gradientStops: [],
  rules: [
    { min: -1, max: 0, color: '#cccccc', label: '低值', applicationRate: 10 },
    { min: 0, max: null, color: '#226622', label: '高值', applicationRate: null },
  ],
};

const GRADIENT_LAYER: ClassificationLayerState = {
  id: 'gradient-b',
  label: '渐变方案',
  noDataColor: '#00000000',
  visible: true,
  mode: 'gradient',
  gradientStops: [
    { value: -1, color: '#ff0000', label: '低' },
    { value: 1, color: '#00ff00', label: '高' },
  ],
  rules: [],
};

function makeMetadata(): RasterMetadata {
  return {
    fileName: 'demo.tif',
    width: 100,
    height: 50,
    samplesPerPixel: 1,
    boundingBox: [0, 0, 10, 5],
    coordinateDisplayMode: 'projected',
    metricExtent: { minX: 0, minY: 0, maxX: 10, maxY: 5 },
    metricWidth: 10,
    metricHeight: 5,
    metricTransform: createIdentityMetricTransform([0, 0, 10, 5]),
    origin: [0, 5, 0],
    resolution: [0.1, -0.1, 0],
    cellSize: { x: 0.1, y: 0.1, unit: 'm' },
    crsCode: 'EPSG:4549',
    crsName: 'CGCS2000',
    isProjected: true,
  };
}

function makeInput(overrides: Partial<ExportProjectSnapshotInput> = {}): ExportProjectSnapshotInput {
  return {
    sourceFile: new File(['demo'], 'demo.tif', { type: 'image/tiff', lastModified: 1_700_000_000_000 }),
    sourceLabel: 'demo.tif',
    metadata: makeMetadata(),
    fenceRings: FENCE_RINGS,
    grid: { cellSize: 2.5, rotation: 47, aggregationMode: 'max' },
    classification: {
      layers: [RULES_LAYER, GRADIENT_LAYER],
      activeLayerId: 'rules-a',
      visibleLayerId: 'gradient-b',
    },
    view: {
      layers: { raster: true, fence: false, grid: true },
      gridRenderSettings: {
        useClassificationColors: false,
        fillColor: '#123456',
        fillOpacity: 0.5,
        strokeColor: '#654321',
        strokeOpacity: 0.9,
        strokeWidth: 3,
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  useFenceStore.getState().reset();
  useGridStore.getState().reset();
  useMapUiStore.getState().reset();
});

describe('normalizeRotation', () => {
  it('normalizes into [0, 360)', () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(47)).toBe(47);
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(Number.NaN)).toBe(0);
  });
});

describe('compareFingerprint', () => {
  const saved = { fileName: 'a.tif', size: 100, lastModified: 1_000_000 };

  it('reports match within the mtime tolerance', () => {
    expect(compareFingerprint(saved, { ...saved, lastModified: 1_001_500 })).toBe('match');
  });

  it('reports mtime-differs when only the timestamp moves', () => {
    expect(compareFingerprint(saved, { ...saved, lastModified: 2_000_000 })).toBe('mtime-differs');
  });

  it('reports mismatch on a different name or size', () => {
    expect(compareFingerprint(saved, { ...saved, fileName: 'b.tif' })).toBe('mismatch');
    expect(compareFingerprint(saved, { ...saved, size: 101 })).toBe('mismatch');
  });
});

describe('exportProjectSnapshot -> toStorePatches', () => {
  it('round-trips every field through the patch conversion', () => {
    const input = makeInput();
    const snapshot = exportProjectSnapshot(input);
    const patches = toStorePatches(snapshot);

    expect(snapshot.kind).toBe('ttot-project');
    expect(snapshot.version).toBe(1);
    expect(snapshot.source?.fingerprint).toEqual({
      fileName: 'demo.tif',
      size: 4,
      lastModified: 1_700_000_000_000,
    });
    expect(snapshot.source?.crsCode).toBe('EPSG:4549');

    expect(patches.fenceRings).toEqual(FENCE_RINGS);
    expect(patches.grid).toEqual({ cellSize: 2.5, rotation: 47, aggregationMode: 'max' });
    expect(patches.classification.layers).toEqual([RULES_LAYER, GRADIENT_LAYER]);
    expect(patches.classification.activeLayerId).toBe('rules-a');
    expect(patches.classification.visibleLayerId).toBe('gradient-b');
    expect(patches.view.layers).toEqual({ raster: true, fence: false, grid: true });
    expect(patches.view.gridRenderSettings.strokeWidth).toBe(3);
  });

  it('does not share references with the snapshot (defensive copies)', () => {
    const snapshot = exportProjectSnapshot(makeInput());
    const patches = toStorePatches(snapshot);

    patches.fenceRings?.[0]?.push([99, 99]);
    expect(snapshot.fence?.rings[0]).toHaveLength(5);

    const firstLayer = patches.classification.layers[0];
    if (firstLayer.mode === 'rules') {
      firstLayer.rules[0].color = '#000000';
    }
    const originalLayer = snapshot.classification.layers[0];
    if (originalLayer.mode === 'rules') {
      expect(originalLayer.rules[0].color).toBe('#cccccc');
    }
  });

  it('normalizes rotation and falls back to the first layer for dangling ids', () => {
    const snapshot = exportProjectSnapshot(
      makeInput({
        grid: { cellSize: 1, rotation: -90, aggregationMode: 'mean' },
        classification: {
          layers: [RULES_LAYER],
          activeLayerId: 'missing',
          visibleLayerId: 'missing',
        },
      }),
    );
    const patches = toStorePatches(snapshot);

    expect(patches.grid.rotation).toBe(270);
    expect(patches.classification.activeLayerId).toBe('rules-a');
    expect(patches.classification.visibleLayerId).toBe('rules-a');
  });
});

describe('serialize / parse', () => {
  it('round-trips through JSON text', () => {
    const snapshot = exportProjectSnapshot(makeInput());
    const parsed = parseProjectSnapshot(serializeProjectSnapshot(snapshot));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.snapshot).toEqual(snapshot);
  });

  it('rejects non-JSON and non-project content', () => {
    expect(parseProjectSnapshot('not json').ok).toBe(false);
    expect(validateProjectSnapshot(null).ok).toBe(false);
    expect(validateProjectSnapshot({ kind: 'other', version: 1 }).ok).toBe(false);
    expect(validateProjectSnapshot({ kind: 'ttot-project', version: '1' }).ok).toBe(false);
  });

  it('rejects a snapshot from a newer version instead of guessing', () => {
    const result = validateProjectSnapshot({ kind: 'ttot-project', version: 2 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('v2');
  });
});

describe('validateProjectSnapshot repairs', () => {
  it('repairs recoverable problems and reports warnings', () => {
    const result = validateProjectSnapshot({
      kind: 'ttot-project',
      version: 1,
      grid: { cellSize: -5, rotation: 400, aggregationMode: 'median' },
      fence: { rings: [[[0, 0], [1, 1]]] },
      classification: {
        layers: [
          {
            id: 'x',
            label: '',
            mode: 'rules',
            noDataColor: 'not-a-color',
            visible: 'yes',
            rules: [
              { min: 0, max: 1, color: 'zzz', label: 'ok', applicationRate: 5 },
              { min: 'bad', max: 1, color: '#000', label: 'bad' },
            ],
          },
        ],
      },
      view: { layers: { raster: 'yes' }, gridRenderSettings: { fillColor: 'nope' } },
      unknownField: 'ignored',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.snapshot.grid.cellSize).toBe(1);
    expect(result.snapshot.grid.rotation).toBe(40);
    expect(result.snapshot.grid.aggregationMode).toBe('mean');
    expect(result.snapshot.fence).toBeNull();
    expect(result.snapshot.classification.layers).toHaveLength(1);

    const layer = result.snapshot.classification.layers[0];
    expect(layer.visible).toBe(true);
    expect(layer.noDataColor).toBe('#00000000');
    if (layer.mode === 'rules') {
      expect(layer.rules).toHaveLength(1);
      expect(layer.rules[0].color).toBe('#cccccc');
      expect(layer.rules[0].applicationRate).toBe(5);
    }
    expect(result.snapshot.view.layers.raster).toBe(true);
    expect(result.snapshot.view.gridRenderSettings.fillColor).toBe('#3388ff');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('drops classification layers that have no usable content', () => {    const result = validateProjectSnapshot({
      kind: 'ttot-project',
      version: 1,
      classification: { layers: [{ id: 'a', mode: 'rules', rules: [] }] },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.classification.layers).toEqual([]);
    expect(result.warnings.join()).toContain('分类方案');
  });

  it('clamps out-of-range render settings instead of propagating them', () => {
    const result = validateProjectSnapshot({
      kind: 'ttot-project',
      version: 1,
      view: { gridRenderSettings: { fillOpacity: 1e9, strokeOpacity: -5, strokeWidth: 1e6 } },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.snapshot.view.gridRenderSettings.fillOpacity).toBe(1);
    expect(result.snapshot.view.gridRenderSettings.strokeOpacity).toBe(0);
    expect(result.snapshot.view.gridRenderSettings.strokeWidth).toBe(100);
    expect(result.warnings.join()).toContain('透明度');
  });

  it('stays quiet about settings that are simply absent', () => {
    const result = validateProjectSnapshot({ kind: 'ttot-project', version: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.snapshot.view.gridRenderSettings).toMatchObject({
      fillOpacity: 0.3,
      strokeOpacity: 0.8,
      strokeWidth: 1,
    });
    expect(result.warnings.join()).not.toContain('透明度');
    expect(result.warnings.join()).not.toContain('边框宽度');
  });
});

describe('application rate fields in snapshots', () => {
  const perAreaLayer: ClassificationLayerState = {
    id: 'rules-a',
    label: '单位面积用量',
    noDataColor: '#00000000',
    visible: true,
    mode: 'rules',
    gradientStops: [],
    rules: [
      {
        min: 0,
        max: null,
        color: '#226622',
        label: '高值',
        applicationRate: 4,
        applicationRateBasis: 'per-area',
        applicationRateUnit: 'per-mu',
      },
    ],
  };

  it('preserves the rate basis and unit through a JSON round-trip', () => {
    // 丢失基准会让重开工程后的处方用量按 cellSize² 漂移，所以必须精确还原
    const snapshot = exportProjectSnapshot(
      makeInput({
        classification: {
          layers: [perAreaLayer],
          activeLayerId: 'rules-a',
          visibleLayerId: 'rules-a',
        },
      }),
    );

    const parsed = parseProjectSnapshot(serializeProjectSnapshot(snapshot));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const layer = parsed.snapshot.classification.layers[0];
    expect(layer.mode).toBe('rules');
    if (layer.mode !== 'rules') return;

    expect(layer.rules[0].applicationRate).toBe(4);
    expect(layer.rules[0].applicationRateBasis).toBe('per-area');
    expect(layer.rules[0].applicationRateUnit).toBe('per-mu');
  });

  it('drops an unknown basis or unit and reports it instead of guessing', () => {
    const result = validateProjectSnapshot({
      kind: 'ttot-project',
      version: 1,
      classification: {
        layers: [
          {
            id: 'rules-a',
            mode: 'rules',
            rules: [
              {
                min: 0,
                max: null,
                color: '#226622',
                label: '高值',
                applicationRate: 4,
                applicationRateBasis: 'per-acre',
                applicationRateUnit: 'kg',
              },
            ],
          },
        ],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const layer = result.snapshot.classification.layers[0];
    if (layer.mode !== 'rules') return;

    expect(layer.rules[0].applicationRateBasis).toBeUndefined();
    expect(layer.rules[0].applicationRateUnit).toBeUndefined();
    expect(result.warnings.join()).toContain('用量基准');
    expect(result.warnings.join()).toContain('用量单位');
  });
});

describe('embedded snapshot encoding', () => {
  it('round-trips through the TIFF-safe prefix + base64 form', () => {
    const snapshot = exportProjectSnapshot(makeInput());
    const encoded = encodeEmbeddedSnapshot(snapshot);

    expect(encoded.startsWith(EMBEDDED_SNAPSHOT_PREFIX)).toBe(true);
    expect(encoded).toMatch(/^[\x20-\x7e]*$/); // 必须是可写入 ASCII tag 的字符集

    const decoded = decodeEmbeddedSnapshot(encoded);
    expect(decoded?.ok).toBe(true);
    if (!decoded || !decoded.ok) return;
    expect(decoded.snapshot).toEqual(snapshot);
  });

  it('returns null for ImageDescription written by other software', () => {
    expect(decodeEmbeddedSnapshot('GDAL 3.9.0, released 2024/05/07')).toBeNull();
    expect(decodeEmbeddedSnapshot('')).toBeNull();
    expect(decodeEmbeddedSnapshot(null)).toBeNull();
  });

  it('tolerates the NUL terminator that geotiff.js keeps on ASCII tags', () => {
    const snapshot = exportProjectSnapshot(makeInput());
    const decoded = decodeEmbeddedSnapshot(`${encodeEmbeddedSnapshot(snapshot)}\0`);

    expect(decoded?.ok).toBe(true);
    if (!decoded || !decoded.ok) return;
    expect(decoded.snapshot).toEqual(snapshot);
  });

  it('reports a damaged payload instead of throwing', () => {
    const result = decodeEmbeddedSnapshot(`${EMBEDDED_SNAPSHOT_PREFIX}!!!!`);

    expect(result?.ok).toBe(false);
  });
});

describe('applyProjectSnapshot', () => {
  it('restores fence, grid and classification into the stores', () => {
    const snapshot = exportProjectSnapshot(makeInput());
    applyProjectSnapshot(snapshot);

    expect(useFenceStore.getState().fence?.geometry.coordinates).toEqual(FENCE_RINGS);
    expect(useFenceStore.getState().mode).toBe('idle');
    expect(useGridStore.getState()).toMatchObject({
      cellSize: 2.5,
      rotation: 47,
      aggregationMode: 'max',
    });
    expect(useMapUiStore.getState().classificationLayers.map((layer) => layer.id)).toEqual([
      'rules-a',
      'gradient-b',
    ]);
    expect(useMapUiStore.getState().activeClassificationLayerId).toBe('rules-a');
    expect(useMapUiStore.getState().visibleClassificationLayerId).toBe('gradient-b');
    expect(useMapUiStore.getState().layers).toEqual({ raster: true, fence: false, grid: true });
    expect(useMapUiStore.getState().gridRenderSettings.useClassificationColors).toBe(false);
  });

  it('clears the fence when the snapshot has none', () => {
    applyProjectSnapshot(exportProjectSnapshot(makeInput()));
    expect(useFenceStore.getState().fence).not.toBeNull();

    applyProjectSnapshot(exportProjectSnapshot(makeInput({ fenceRings: null })));
    expect(useFenceStore.getState().fence).toBeNull();
  });

  it('keeps the current classification layers when the snapshot carries none', () => {
    const before = useMapUiStore.getState().classificationLayers.map((layer) => layer.id);

    applyProjectSnapshot(
      exportProjectSnapshot(
        makeInput({
          classification: { layers: [], activeLayerId: null, visibleLayerId: null },
        }) as ExportProjectSnapshotInput,
      ) as ProjectSnapshotV1,
    );

    expect(useMapUiStore.getState().classificationLayers.map((layer) => layer.id)).toEqual(before);
  });

  it('normalizes a display pointer that targets a hidden layer', () => {
    const hiddenGradient: ClassificationLayerState = { ...GRADIENT_LAYER, visible: false };

    applyProjectSnapshot(
      exportProjectSnapshot(
        makeInput({
          classification: {
            layers: [RULES_LAYER, hiddenGradient],
            activeLayerId: 'gradient-b',
            visibleLayerId: 'gradient-b',
          },
        }),
      ),
    );

    // 当前方案可以指向隐藏图层，但「显示中」的图层必须是可见的
    expect(useMapUiStore.getState().activeClassificationLayerId).toBe('gradient-b');
    expect(useMapUiStore.getState().visibleClassificationLayerId).toBe('rules-a');
  });
});

describe('buildRestorePlan', () => {
  const currentFingerprint = {
    fileName: 'demo.tif',
    size: 4,
    lastModified: 1_700_000_000_000,
  };

  it('applies freely when the snapshot records no source', () => {
    const plan = buildRestorePlan({
      snapshot: exportProjectSnapshot(makeInput({ sourceFile: null, metadata: null })),
      currentFingerprint: null,
    });

    expect(plan.action).toBe('apply');
    expect(plan.fingerprintMatch).toBe('no-source');
    expect(plan.warnings).toEqual([]);
  });

  it('asks for the source image when nothing is loaded', () => {
    const plan = buildRestorePlan({
      snapshot: exportProjectSnapshot(makeInput()),
      currentFingerprint: null,
    });

    expect(plan.action).toBe('request-source');
    expect(plan.fingerprintMatch).toBe('no-current-file');
    expect(plan.warnings[0]).toContain('请选择源影像');
  });

  it('applies when the fingerprint matches', () => {
    const plan = buildRestorePlan({
      snapshot: exportProjectSnapshot(makeInput()),
      currentFingerprint,
      currentCrsCode: 'EPSG:4549',
      currentBoundingBox: [-10, -10, 20, 20],
    });

    expect(plan.action).toBe('apply');
    expect(plan.fingerprintMatch).toBe('match');
    expect(plan.errors).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it('warns but still applies on a fingerprint mismatch', () => {
    const plan = buildRestorePlan({
      snapshot: exportProjectSnapshot(makeInput()),
      currentFingerprint: { ...currentFingerprint, size: 999 },
      currentCrsCode: 'EPSG:4549',
      currentBoundingBox: [-10, -10, 20, 20],
    });

    expect(plan.action).toBe('apply');
    expect(plan.fingerprintMatch).toBe('mismatch');
    expect(plan.warnings[0]).toContain('不一致');
  });

  it('refuses to auto-apply when the CRS differs', () => {
    const plan = buildRestorePlan({
      snapshot: exportProjectSnapshot(makeInput()),
      currentFingerprint,
      currentCrsCode: 'EPSG:4326',
      currentBoundingBox: [-10, -10, 20, 20],
    });

    expect(plan.action).toBe('blocked');
    expect(plan.crsMismatch).toBe(true);
    expect(plan.errors[0]).toContain('坐标系不一致');
  });

  it('flags a fence that falls outside the loaded raster', () => {
    const plan = buildRestorePlan({
      snapshot: exportProjectSnapshot(makeInput()),
      currentFingerprint,
      currentCrsCode: 'EPSG:4549',
      currentBoundingBox: [100, 100, 110, 110],
    });

    // 有 error 时动作本身必须是 blocked，不能依赖调用方记得检查 errors
    expect(plan.action).toBe('blocked');
    expect(plan.fenceOutsideRaster).toBe(true);
    expect(plan.errors[0]).toContain('围栏超出影像范围');
  });
});
