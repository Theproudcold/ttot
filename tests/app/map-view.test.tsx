import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MapView } from '@/features/map/MapView';
import { useFenceStore } from '@/features/fence/fenceStore';
import { useMapUiStore } from '@/features/map/mapUiStore';
import { useRasterStore } from '@/features/map/rasterStore';
import { scheduleMapResizeFrame } from '@/features/map/useMap';

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
    expect(screen.getByText('色带图例')).toBeInTheDocument();
    expect(screen.getByText('0.00 ~ 0.20')).toBeInTheDocument();
    expect(screen.getByText('命中围栏：是')).toBeInTheDocument();
    expect(screen.getByText('命中网格：r10-c20')).toBeInTheDocument();
  });
});
