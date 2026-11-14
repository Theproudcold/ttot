import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MapView } from '@/features/map/MapView';
import { useFenceStore } from '@/features/fence/fenceStore';
import { useMapUiStore } from '@/features/map/mapUiStore';
import { useRasterStore } from '@/features/map/rasterStore';
import {
  createAnimationFrameValueScheduler,
  getGridCellStyleColors,
  scheduleMapResizeFrame,
} from '@/features/map/useMap';
import { createGridCellHitTester } from '@/features/map/mapUtils';
import { createMetricTransform } from '@/shared/geo/crs';
import type { GridCell, GridRenderSettings } from '@/shared/types/grid';
import type { RasterClassificationLayer, RasterMetadata } from '@/shared/types/raster';

const defaultGridRenderSettings: GridRenderSettings = {
  useClassificationColors: true,
  fillColor: '#3388ff',
  fillOpacity: 0.25,
  strokeColor: '#3388ff',
  strokeOpacity: 0.8,
  strokeWidth: 1,
};

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

function createGridCell(outputValue: number | null): GridCell {
  return {
    id: 'r0-c0',
    row: 0,
    col: 0,
    center: [0.5, 0.5],
    polygon: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0],
      ],
    ],
    aggregation: {
      cellId: 'r0-c0',
      row: 0,
      col: 0,
      pixelCount: 1,
      validPixelCount: outputValue === null ? 0 : 1,
      sumValue: outputValue ?? 0,
      meanValue: outputValue,
      minValue: outputValue,
      maxValue: outputValue,
      outputValue,
    },
  };
}

function createPendingGridCell(): GridCell {
  return {
    id: 'r0-c0',
    row: 0,
    col: 0,
    center: [0.5, 0.5],
    polygon: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0],
      ],
    ],
  };
}

function createIndexedGridCell(
  id: string,
  row: number,
  col: number,
  polygon: GridCell['polygon'],
): GridCell {
  return {
    id,
    row,
    col,
    center: polygon[0][0] ?? [0, 0],
    polygon,
  };
}

function createRasterMetadata(
  overrides: Partial<RasterMetadata> & Pick<RasterMetadata, 'boundingBox' | 'crsCode'>,
): RasterMetadata {
  const { boundingBox, crsCode, ...rest } = overrides;
  const metricTransform = createMetricTransform({
    crsCode,
    boundingBox,
  });

  return {
    sourceUrl: null,
    fileName: 'test.tif',
    width: 100,
    height: 100,
    samplesPerPixel: 1,
    ...rest,
    boundingBox,
    coordinateDisplayMode: metricTransform.coordinateDisplayMode,
    metricExtent: metricTransform.metricExtent,
    metricWidth: metricTransform.metricWidth,
    metricHeight: metricTransform.metricHeight,
    metricTransform,
    origin: rest.origin ?? [boundingBox[0], boundingBox[3], 0],
    resolution: rest.resolution ?? [1, -1, 0],
    cellSize: rest.cellSize ?? { x: 1, y: 1, unit: 'm' },
    crsCode,
    crsName: rest.crsName ?? crsCode,
    isProjected: rest.isProjected ?? metricTransform.coordinateDisplayMode === 'projected',
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

  it('keeps grid strokes visible while aggregation is pending or empty in classification mode', () => {
    const pendingColors = getGridCellStyleColors(createPendingGridCell(), null, defaultGridRenderSettings);
    const emptyColors = getGridCellStyleColors(createGridCell(null), null, defaultGridRenderSettings);
    const visibleColors = getGridCellStyleColors(createGridCell(0.62), createRulesClassificationLayer(), defaultGridRenderSettings);

    expect(pendingColors).toEqual({
      strokeColor: 'rgba(51, 136, 255, 0.8)',
      fillColor: 'rgba(0, 0, 0, 0)',
    });
    expect(emptyColors).toEqual({
      strokeColor: 'rgba(51, 136, 255, 0.8)',
      fillColor: 'rgba(0, 0, 0, 0)',
    });
    expect(visibleColors.strokeColor).toBe('rgba(51, 136, 255, 0.8)');
    expect(visibleColors.fillColor).toBe('#1f7a1f');
  });

  it('coalesces multiple animation-frame values into the latest payload', () => {
    const received: number[] = [];
    const frameCallbacks: FrameRequestCallback[] = [];
    const scheduler = vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    const cancel = vi.fn();
    const valueScheduler = createAnimationFrameValueScheduler(
      (value: number) => {
        received.push(value);
      },
      scheduler,
      cancel,
    );

    valueScheduler.schedule(1);
    valueScheduler.schedule(2);
    valueScheduler.schedule(3);

    expect(scheduler).toHaveBeenCalledTimes(1);
    expect(received).toEqual([]);

    frameCallbacks[0]?.(16);

    expect(received).toEqual([3]);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('finds grid hits from the indexed row and column before falling back to polygon scan', () => {
    const hitTester = createGridCellHitTester({
      cells: [
        createIndexedGridCell('r0-c0', 0, 0, [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
          ],
        ]),
      ],
      fenceRings: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ],
      cellSize: 1,
    });

    expect(hitTester([0.5, 0.5])?.id).toBe('r0-c0');
  });

  it('falls back to polygon scan when indexed lookup misses', () => {
    const fallbackCell = createIndexedGridCell('r9-c9', 9, 9, [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0],
      ],
    ]);
    const hitTester = createGridCellHitTester({
      cells: [fallbackCell],
      fenceRings: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ],
      cellSize: 1,
    });

    expect(hitTester([0.5, 0.5])?.id).toBe('r9-c9');
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

  it('keeps the legend for a rules export re-imported with an appended prescription band', () => {
    act(() => {
      useRasterStore.getState().setPreview({
        url: 'data:image/png;base64,preview',
        width: 4,
        height: 1,
        // rules 模式导出的文件会多出一个处方波段，但数据波段仍只有 1 个
        sampleBandCount: 2,
        classificationBandCount: 1,
        sampleData: new Float32Array([-0.2, 0.3, 0.5, 0.8, 50, 80, 80, 120]),
        sampleRanges: [{ min: -0.2, max: 0.8 }, { min: 50, max: 120 }],
        noDataValue: null,
      });
      useMapUiStore.getState().addClassificationLayer(createRulesClassificationLayer());
      useMapUiStore.getState().setVisibleClassificationLayer('landcover-rules');
    });

    render(<MapView />);

    // 与 useMap 的着色判定保持一致：地图着色时图例必须同时存在
    expect(screen.getByLabelText('raster-legend')).toBeInTheDocument();
    expect(screen.getByText('土地覆盖')).toBeInTheDocument();
    expect(screen.getByText('高覆盖')).toBeInTheDocument();
  });
});
