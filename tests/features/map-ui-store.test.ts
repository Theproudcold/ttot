import { act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useMapUiStore } from '@/features/map/mapUiStore';

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
});
