import { act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useMapUiStore } from '@/features/map/mapUiStore';
import type { RasterClassificationLayer } from '@/shared/types/raster';

type UpdateClassificationLayerPayload = ReturnType<
  typeof useMapUiStore.getState
>['updateClassificationLayer'] extends (layerId: string, updates: infer T) => unknown ? T : never;

function createRuleLayer(
  id: string,
  label: string,
  visible = true,
): RasterClassificationLayer & { visible: boolean } {
  return {
    id,
    label,
    visible,
    mode: 'rules',
    noDataColor: '#00000000',
    gradientStops: [],
    rules: [
      { min: -1, max: 0.3, color: '#cccccc', label: '低' },
      { min: 0.3, max: null, color: '#226622', label: '高' },
    ],
  };
}

function createGradientLayer(
  id: string,
  label: string,
  visible = true,
): RasterClassificationLayer & { visible: boolean } {
  return {
    id,
    label,
    visible,
    mode: 'gradient',
    noDataColor: '#00000000',
    gradientStops: [
      { value: -1, color: '#8b1e3f', label: '低植被' },
      { value: 1, color: '#0b3d0b', label: '高植被' },
    ],
    rules: [],
  };
}

describe('useMapUiStore', () => {
  afterEach(() => {
    act(() => {
      useMapUiStore.getState().reset();
    });
  });

  it('toggles layer visibility and stores hover info', () => {
    act(() => {
      useMapUiStore.getState().toggleLayer('grid');
      useMapUiStore.getState().setHoverInfo({
        coordinate: [100, 200],
        pixel: { row: 12, col: 34 },
        sampleValues: [128],
        inValidityMask: true,
        inFence: false,
        gridCellId: 'r10-c20',
      });
    });

    expect(useMapUiStore.getState().layers.grid).toBe(false);
    expect(useMapUiStore.getState().hoverInfo).toEqual({
      coordinate: [100, 200],
      pixel: { row: 12, col: 34 },
      sampleValues: [128],
      inValidityMask: true,
      inFence: false,
      gridCellId: 'r10-c20',
      gridMeanValue: null,
      gridValidPixelCount: null,
    });
  });

  it('normalizes omitted grid aggregation hover fields to null for legacy callers', () => {
    act(() => {
      useMapUiStore.getState().setHoverInfo({
        coordinate: [1, 2],
        pixel: { row: 3, col: 4 },
        sampleValues: [5],
        classificationLayerName: null,
        classificationLabel: null,
        classificationColor: null,
        inValidityMask: null,
        inFence: true,
        gridCellId: null,
      });
    });

    expect(useMapUiStore.getState().hoverInfo).toEqual({
      coordinate: [1, 2],
      pixel: { row: 3, col: 4 },
      sampleValues: [5],
      classificationLayerName: null,
      classificationLabel: null,
      classificationColor: null,
      inValidityMask: null,
      inFence: true,
      gridCellId: null,
      gridMeanValue: null,
      gridValidPixelCount: null,
    });
  });

  it('tracks raster classification settings and resets them to defaults', () => {
    act(() => {
      useMapUiStore.getState().setRasterRenderSettings({
        min: -0.4,
        max: 1,
        step: 0.5,
      });
    });

    expect(useMapUiStore.getState().rasterRenderSettings).toEqual({
      min: -0.4,
      max: 1,
      step: 0.5,
    });

    act(() => {
      useMapUiStore.getState().reset();
    });

    expect(useMapUiStore.getState().rasterRenderSettings).toEqual({
      min: null,
      max: null,
      step: 0.2,
    });
  });

  it('injects the default NDVI classification layer and restores it on reset', () => {
    expect(useMapUiStore.getState().classificationLayers).toEqual([
      expect.objectContaining({
        id: 'ndvi-default',
        label: 'NDVI 默认',
        mode: 'gradient',
        visible: true,
      }),
    ]);
    expect(useMapUiStore.getState().activeClassificationLayerId).toBe('ndvi-default');
    expect(useMapUiStore.getState().visibleClassificationLayerId).toBe('ndvi-default');

    act(() => {
      useMapUiStore.getState().addClassificationLayer(createRuleLayer('custom-layer', '自定义方案'));
    });

    expect(useMapUiStore.getState().classificationLayers).toHaveLength(2);

    act(() => {
      useMapUiStore.getState().reset();
    });

    expect(useMapUiStore.getState().classificationLayers).toEqual([
      expect.objectContaining({
        id: 'ndvi-default',
        label: 'NDVI 默认',
        mode: 'gradient',
        visible: true,
      }),
    ]);
    expect(useMapUiStore.getState().activeClassificationLayerId).toBe('ndvi-default');
    expect(useMapUiStore.getState().visibleClassificationLayerId).toBe('ndvi-default');
  });

  it('ignores addClassificationLayer calls with duplicate ids', () => {
    act(() => {
      useMapUiStore.getState().addClassificationLayer(createRuleLayer('scheme-a', '方案 A'));
      useMapUiStore
        .getState()
        .addClassificationLayer(createGradientLayer('scheme-a', '重复方案 A', false));
    });

    const schemeALayers = useMapUiStore
      .getState()
      .classificationLayers.filter((layer) => layer.id === 'scheme-a');

    expect(schemeALayers).toHaveLength(1);
    expect(schemeALayers[0]).toEqual(
      expect.objectContaining({
        id: 'scheme-a',
        label: '方案 A',
        mode: 'rules',
        visible: true,
      }),
    );
    expect(useMapUiStore.getState().classificationLayers).toHaveLength(2);
    expect(useMapUiStore.getState().activeClassificationLayerId).toBe('ndvi-default');
    expect(useMapUiStore.getState().visibleClassificationLayerId).toBe('ndvi-default');
  });

  it('adds updates duplicates and deletes classification layers while keeping active and visible ids valid', () => {
    act(() => {
      useMapUiStore.getState().addClassificationLayer(createRuleLayer('scheme-a', '方案 A'));
      useMapUiStore.getState().addClassificationLayer(createRuleLayer('scheme-b', '方案 B', false));
      useMapUiStore.getState().updateClassificationLayer('scheme-a', {
        label: '方案 A - 已更新',
        visible: false,
      });
    });

    expect(useMapUiStore.getState().classificationLayers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'scheme-a',
          label: '方案 A - 已更新',
          visible: false,
        }),
        expect.objectContaining({
          id: 'scheme-b',
          label: '方案 B',
          visible: false,
        }),
      ]),
    );
    expect(useMapUiStore.getState().visibleClassificationLayerId).toBe('ndvi-default');

    act(() => {
      useMapUiStore.getState().setActiveClassificationLayer('scheme-a');
      useMapUiStore.getState().setVisibleClassificationLayer('scheme-b');
    });

    expect(useMapUiStore.getState().activeClassificationLayerId).toBe('scheme-a');
    expect(useMapUiStore.getState().visibleClassificationLayerId).toBe('scheme-b');
    expect(
      useMapUiStore
        .getState()
        .classificationLayers.find((layer) => layer.id === 'scheme-b')?.visible,
    ).toBe(true);

    let duplicatedLayerId: string | null = null;
    act(() => {
      duplicatedLayerId = useMapUiStore.getState().duplicateClassificationLayer('scheme-b');
    });

    expect(duplicatedLayerId).toBeTruthy();
    const duplicatedLayer = useMapUiStore
      .getState()
      .classificationLayers.find((layer) => layer.id === duplicatedLayerId);
    expect(duplicatedLayer).toBeDefined();
    expect(duplicatedLayer).toEqual(
      expect.objectContaining({
        label: '方案 B 副本',
        visible: true,
        mode: 'rules',
      }),
    );

    act(() => {
      useMapUiStore.getState().deleteClassificationLayer('scheme-a');
    });

    expect(useMapUiStore.getState().activeClassificationLayerId).toBe('scheme-b');

    act(() => {
      useMapUiStore.getState().deleteClassificationLayer('scheme-b');
    });

    expect(useMapUiStore.getState().visibleClassificationLayerId).toBe(duplicatedLayerId);
  });

  it('toggles classification layer visibility and always points visibleClassificationLayerId at a visible layer when one exists', () => {
    act(() => {
      useMapUiStore.getState().addClassificationLayer(createRuleLayer('scheme-a', '方案 A'));
      useMapUiStore.getState().addClassificationLayer(createRuleLayer('scheme-b', '方案 B'));
      useMapUiStore.getState().setVisibleClassificationLayer('scheme-a');
      useMapUiStore.getState().toggleClassificationLayerVisibility('scheme-a');
    });

    expect(useMapUiStore.getState().visibleClassificationLayerId).toBe('ndvi-default');

    act(() => {
      useMapUiStore.getState().toggleClassificationLayerVisibility('ndvi-default');
    });

    expect(useMapUiStore.getState().visibleClassificationLayerId).toBe('scheme-b');

    act(() => {
      useMapUiStore.getState().toggleClassificationLayerVisibility('scheme-b');
    });

    expect(useMapUiStore.getState().visibleClassificationLayerId).toBeNull();

    act(() => {
      useMapUiStore.getState().toggleClassificationLayerVisibility('scheme-a');
    });

    expect(useMapUiStore.getState().visibleClassificationLayerId).toBe('scheme-a');
  });

  it('keeps ids unique and migrates active and visible references when a layer id changes', () => {
    act(() => {
      useMapUiStore.getState().addClassificationLayer(createRuleLayer('scheme-a', '方案 A'));
      useMapUiStore.getState().addClassificationLayer(createRuleLayer('scheme-b', '方案 B'));
      useMapUiStore.getState().setActiveClassificationLayer('scheme-a');
      useMapUiStore.getState().setVisibleClassificationLayer('scheme-a');
      useMapUiStore.getState().updateClassificationLayer('scheme-a', {
        id: 'scheme-renamed',
        label: '方案 A 新名字',
      });
    });

    expect(
      useMapUiStore.getState().classificationLayers.find((layer) => layer.id === 'scheme-renamed'),
    ).toEqual(
      expect.objectContaining({
        id: 'scheme-renamed',
        label: '方案 A 新名字',
      }),
    );
    expect(useMapUiStore.getState().activeClassificationLayerId).toBe('scheme-renamed');
    expect(useMapUiStore.getState().visibleClassificationLayerId).toBe('scheme-renamed');

    act(() => {
      useMapUiStore.getState().updateClassificationLayer('scheme-renamed', {
        id: 'scheme-b',
        label: '方案 A 继续改名',
      });
    });

    expect(
      useMapUiStore.getState().classificationLayers.filter((layer) => layer.id === 'scheme-b'),
    ).toHaveLength(1);
    expect(
      useMapUiStore.getState().classificationLayers.find((layer) => layer.id === 'scheme-renamed'),
    ).toEqual(
      expect.objectContaining({
        id: 'scheme-renamed',
        label: '方案 A 继续改名',
      }),
    );
    expect(useMapUiStore.getState().activeClassificationLayerId).toBe('scheme-renamed');
    expect(useMapUiStore.getState().visibleClassificationLayerId).toBe('scheme-renamed');
  });

  it('normalizes classification data when switching modes', () => {
    const switchToGradientUpdate: UpdateClassificationLayerPayload = {
      mode: 'gradient',
      gradientStops: [
        { value: 0, color: '#111111', label: '低' },
        { value: 1, color: '#eeeeee', label: '高' },
      ],
      rules: [
        { min: -1, max: 0.5, color: '#cccccc', label: '旧规则' },
        { min: 0.5, max: null, color: '#226622', label: '旧规则 2' },
      ],
    };
    const switchToRulesUpdate: UpdateClassificationLayerPayload = {
      mode: 'rules',
      gradientStops: [
        { value: -1, color: '#8b1e3f', label: '旧渐变' },
        { value: 1, color: '#0b3d0b', label: '旧渐变 2' },
      ],
      rules: [
        { min: -1, max: 0.2, color: '#bbbbbb', label: '低' },
        { min: 0.2, max: null, color: '#00aa00', label: '高' },
      ],
    };

    act(() => {
      useMapUiStore.getState().addClassificationLayer(createRuleLayer('scheme-a', '方案 A'));
      useMapUiStore.getState().addClassificationLayer(createGradientLayer('scheme-b', '方案 B'));
      useMapUiStore.getState().updateClassificationLayer('scheme-a', switchToGradientUpdate);
      useMapUiStore.getState().updateClassificationLayer('scheme-b', switchToRulesUpdate);
    });

    expect(
      useMapUiStore.getState().classificationLayers.find((layer) => layer.id === 'scheme-a'),
    ).toEqual(
      expect.objectContaining({
        id: 'scheme-a',
        mode: 'gradient',
        rules: [],
        gradientStops: [
          { value: 0, color: '#111111', label: '低' },
          { value: 1, color: '#eeeeee', label: '高' },
        ],
      }),
    );
    expect(
      useMapUiStore.getState().classificationLayers.find((layer) => layer.id === 'scheme-b'),
    ).toEqual(
      expect.objectContaining({
        id: 'scheme-b',
        mode: 'rules',
        gradientStops: [],
        rules: [
          { min: -1, max: 0.2, color: '#bbbbbb', label: '低' },
          { min: 0.2, max: null, color: '#00aa00', label: '高' },
        ],
      }),
    );
  });
});
