import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MapView } from '@/features/map/MapView';
import { useFenceStore } from '@/features/fence/fenceStore';
import { useMapUiStore } from '@/features/map/mapUiStore';
import { useRasterStore } from '@/features/map/rasterStore';
import { scheduleMapResizeFrame } from '@/features/map/useMap';
import type { RasterClassificationLayer } from '@/shared/types/raster';

function createRulesClassificationLayer(): RasterClassificationLayer & { visible: boolean } {
  return {
    id: 'landcover-rules',
    label: '土地覆盖',
    visible: true,
    mode: 'rules',
    noDataColor: '#00000000',
    gradientStops: [],
    rules: [
      { min: -1, max: 0.2, color: '#c2b280', label: '裸地' },
      { min: 0.2, max: 0.6, color: '#7fbf3f', label: '中覆盖' },
      { min: 0.6, max: null, color: '#1f7a1f', label: '高覆盖' },
    ],
  };
}

describe('MapView', () => {
  afterEach(() => {
    act(() => {
      useFenceStore.getState().reset();
      useMapUiStore.getState().reset();
      useRasterStore.getState().reset();
    });
  });

  it('renders fit actions for raster and fence navigation', () => {
    render(<MapView />);

    expect(screen.getByRole('button', { name: '适配影像' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '适配围栏' })).toBeInTheDocument();
  });

  it('skips deferred resize work when the map target is gone', () => {
    const updateSize = vi.fn();
    const renderSync = vi.fn();
    const schedule = vi.fn((callback: FrameRequestCallback) => {
      callback(16);
      return 1;
    });

    scheduleMapResizeFrame(
      {
        getTarget: () => null,
        updateSize,
        renderSync,
      },
      undefined,
      schedule,
    );

    expect(updateSize).not.toHaveBeenCalled();
    expect(renderSync).not.toHaveBeenCalled();
  });

  it('does not throw when renderSync fails during deferred resize', () => {
    const updateSize = vi.fn();
    const renderSync = vi.fn(() => {
      throw new TypeError('Cannot read properties of null (reading renderFrame)');
    });
    const schedule = vi.fn((callback: FrameRequestCallback) => {
      callback(16);
      return 1;
    });

    expect(() =>
      scheduleMapResizeFrame(
        {
          getTarget: () => document.createElement('div'),
          updateSize,
          renderSync,
        },
        undefined,
        schedule,
      ),
    ).not.toThrow();
    expect(updateSize).toHaveBeenCalledTimes(1);
    expect(renderSync).toHaveBeenCalledTimes(1);
  });

  it('renders hover info card when pointer diagnostics exist', () => {
    act(() => {
      useRasterStore.getState().setPreview({
        url: 'data:image/png;base64,preview',
        width: 320,
        height: 180,
        sampleBandCount: 1,
        sampleData: new Float32Array([0.1, 0.3, 0.5, 0.7]),
        sampleRanges: [{ min: 0.1, max: 0.7 }],
        noDataValue: 0,
      });
      useMapUiStore.getState().setHoverInfo({
        coordinate: [447976.08, 4041596.42],
        pixel: { row: 1590, col: 2823 },
        sampleValues: [128],
        classificationLabel: '0.20 ~ 0.40',
        classificationColor: '#777777',
        inValidityMask: true,
        inFence: true,
        gridCellId: 'r10-c20',
      });
    });

    render(<MapView />);

    expect(screen.getByLabelText('hover-card')).toBeInTheDocument();
    expect(screen.getByLabelText('raster-legend')).toBeInTheDocument();
    expect(screen.getByText('NDVI 默认')).toBeInTheDocument();
    expect(screen.getByLabelText('gradient-legend')).toBeInTheDocument();
    expect(screen.getByText('命中围栏：是')).toBeInTheDocument();
    expect(screen.getByText('命中网格：r10-c20')).toBeInTheDocument();
  });

  it('renders the default NDVI gradient legend with the visible scheme name', () => {
    act(() => {
      useRasterStore.getState().setPreview({
        url: 'data:image/png;base64,preview',
        width: 4,
        height: 1,
        sampleBandCount: 1,
        sampleData: new Float32Array([-1, 0, 0.4, 0.7]),
        sampleRanges: [{ min: -1, max: 0.7 }],
        noDataValue: null,
      });
    });

    render(<MapView />);

    expect(screen.getByLabelText('raster-legend')).toBeInTheDocument();
    expect(screen.getByText('NDVI 默认')).toBeInTheDocument();
    expect(screen.getByLabelText('gradient-legend')).toBeInTheDocument();
    expect(screen.getByText('低植被')).toBeInTheDocument();
    expect(screen.getByText('极高植被')).toBeInTheDocument();
  });

  it('renders discrete legend items for the visible rules classification scheme', () => {
    act(() => {
      useRasterStore.getState().setPreview({
        url: 'data:image/png;base64,preview',
        width: 4,
        height: 1,
        sampleBandCount: 1,
        sampleData: new Float32Array([-0.2, 0.3, 0.5, 0.8]),
        sampleRanges: [{ min: -0.2, max: 0.8 }],
        noDataValue: null,
      });
      useMapUiStore.getState().addClassificationLayer(createRulesClassificationLayer());
      useMapUiStore.getState().setVisibleClassificationLayer('landcover-rules');
    });

    render(<MapView />);

    expect(screen.getByLabelText('raster-legend')).toBeInTheDocument();
    expect(screen.getByText('土地覆盖')).toBeInTheDocument();
    expect(screen.queryByLabelText('gradient-legend')).not.toBeInTheDocument();
    expect(screen.getByText('裸地')).toBeInTheDocument();
    expect(screen.getByText('中覆盖')).toBeInTheDocument();
    expect(screen.getByText('高覆盖')).toBeInTheDocument();
  });
});
