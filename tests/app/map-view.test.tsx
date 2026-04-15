import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MapView } from '@/features/map/MapView';
import { useFenceStore } from '@/features/fence/fenceStore';
import { useMapUiStore } from '@/features/map/mapUiStore';
import { useRasterStore } from '@/features/map/rasterStore';
import {
  createAnimationFrameValueScheduler,
  createGridCellHitTester,
  getGridCellStyleColors,
  scheduleMapResizeFrame,
} from '@/features/map/useMap';
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
      outputValue,
    },
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

  it('returns fully transparent grid styles when a cell has no aggregated output value', () => {
    const transparentColors = getGridCellStyleColors(createGridCell(null), null, defaultGridRenderSettings);
    const visibleColors = getGridCellStyleColors(createGridCell(0.62), createRulesClassificationLayer(), defaultGridRenderSettings);

    expect(transparentColors).toEqual({
      strokeColor: 'rgba(0, 0, 0, 0)',
      fillColor: 'rgba(0, 0, 0, 0)',
    });
    expect(visibleColors.strokeColor).toBe('rgba(0, 0, 0, 0.18)');
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

  it('renders hover info card with projected coordinates using two decimals', () => {
    act(() => {
      useRasterStore.getState().setMetadata(
        createRasterMetadata({
          fileName: 'test2.tif',
          boundingBox: [447934.5768945037, 4041573.0550815426, 448017.5877945037, 4041619.7863815427],
          origin: [447934.5768945037, 4041619.7863815427, 0],
          resolution: [0.0147, -0.0147, 0],
          cellSize: { x: 0.0147, y: 0.0147, unit: 'm' },
          crsCode: 'EPSG:4549',
          isProjected: true,
        }),
      );
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
        gridMeanValue: 0.62,
        gridValidPixelCount: 18,
      });
    });

    render(<MapView />);

    expect(screen.getByLabelText('hover-card')).toBeInTheDocument();
    expect(screen.getByLabelText('raster-legend')).toBeInTheDocument();
    expect(screen.getByText('NDVI 默认')).toBeInTheDocument();
    expect(screen.getByLabelText('gradient-legend')).toBeInTheDocument();
    expect(screen.getByText('坐标：447976.08, 4041596.42')).toBeInTheDocument();
    expect(screen.getByText('命中围栏：是')).toBeInTheDocument();
    expect(screen.getByText('命中网格：r10-c20')).toBeInTheDocument();
    expect(screen.getByText('网格均值：0.62')).toBeInTheDocument();
    expect(screen.getByText('有效像元：18')).toBeInTheDocument();
  });

  it('renders geographic hover coordinates with six decimals', () => {
    act(() => {
      useRasterStore.getState().setMetadata(
        createRasterMetadata({
          fileName: 'gps-ndvi.tif',
          boundingBox: [119.420001, 36.510001, 119.420901, 36.510601],
          origin: [119.420001, 36.510601, 0],
          resolution: [0.0000004, -0.0000004, 0],
          cellSize: { x: 0.0000004, y: 0.0000004, unit: 'degree' },
          crsCode: 'EPSG:4326',
          isProjected: false,
        }),
      );
      useMapUiStore.getState().setHoverInfo({
        coordinate: [119.420456, 36.510654],
        pixel: { row: 3, col: 4 },
        sampleValues: [0.13],
        classificationLabel: null,
        classificationColor: null,
        inValidityMask: true,
        inFence: false,
        gridCellId: null,
        gridMeanValue: null,
        gridValidPixelCount: null,
      });
    });

    render(<MapView />);

    expect(screen.getByText('坐标：119.420456, 36.510654')).toBeInTheDocument();
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
