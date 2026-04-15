import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { RightPanel } from '@/app/layout/RightPanel';
import { useFenceStore } from '@/features/fence/fenceStore';
import { useGridStore } from '@/features/grid/gridStore';
import { useMapUiStore } from '@/features/map/mapUiStore';
import { useRasterStore } from '@/features/map/rasterStore';
import { createMetricTransform } from '@/shared/geo/crs';
import type { RasterMetadata } from '@/shared/types/raster';

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

function getMetricItem(label: string): HTMLElement {
  const labelNode = screen
    .getAllByText(label)
    .find((node) => node.tagName.toLowerCase() === 'dt');

  if (!labelNode) {
    throw new Error(`Unable to find metric item for label "${label}"`);
  }

  return labelNode.closest('.metric-item') as HTMLElement;
}

describe('RightPanel', () => {
  afterEach(() => {
    act(() => {
      useFenceStore.getState().reset();
      useGridStore.getState().reset();
      useMapUiStore.getState().reset();
      useRasterStore.getState().reset();
    });
  });

  it('renders fence summary after a polygon is set', () => {
    act(() => {
      useFenceStore.getState().setFence([
        [
          [0, 0],
          [10, 0],
          [10, 20],
          [0, 20],
          [0, 0],
        ],
      ]);
    });

    render(<RightPanel />);

    expect(screen.getByText('200.00 m²')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('0.00, 0.00, 10.00, 20.00')).toBeInTheDocument();
  });

  it('renders estimated grid count from store', () => {
    act(() => {
      useGridStore.getState().setSummary({
        cellSize: 1,
        rows: 100,
        cols: 100,
        totalCells: 10000,
        previewCellCount: 10000,
        isPreviewLimited: false,
        previewStride: 1,
        warning: null,
        rotation: 0,
      });
    });

    render(<RightPanel />);

    expect(
      within(screen.getByText('预计网格').closest('.metric-item') as HTMLElement).getByText('10000'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByText('命中网格').closest('.metric-item') as HTMLElement).getByText('10000'),
    ).toBeInTheDocument();
  });

  it('renders placeholders when fence is invalid but no right-panel warning card is shown', () => {
    act(() => {
      useFenceStore.getState().setValidationMessage('围栏必须落在影像有效数据范围内');
    });

    render(<RightPanel />);

    expect(screen.queryByText('围栏必须落在影像有效数据范围内')).not.toBeInTheDocument();
    expect(
      within(screen.getByText('围栏面积').closest('.metric-item') as HTMLElement).getByText('--'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByText('命中网格').closest('.metric-item') as HTMLElement).getByText('--'),
    ).toBeInTheDocument();
  });

  it('renders layer toggles and classification hover diagnostics', () => {
    act(() => {
      useMapUiStore.getState().toggleLayer('grid');
      useMapUiStore.getState().setHoverInfo({
        coordinate: [447976.08, 4041596.42],
        pixel: { row: 1590, col: 2823 },
        sampleValues: [128],
        classificationLayerName: 'NDVI 默认',
        classificationLabel: '0.20 ~ 0.40',
        classificationColor: '#777777',
        inValidityMask: true,
        inFence: false,
        gridCellId: 'r10-c20',
        gridMeanValue: null,
        gridValidPixelCount: null,
      });
    });

    render(<RightPanel />);

    expect(screen.getByLabelText('切换影像图层')).toBeChecked();
    expect(screen.getByLabelText('切换围栏图层')).toBeChecked();
    expect(screen.getByLabelText('切换网格图层')).not.toBeChecked();
    expect(
      within(getMetricItem('坐标')).getByText('447976.08, 4041596.42'),
    ).toBeInTheDocument();
    expect(screen.getByText('1590 / 2823')).toBeInTheDocument();
    expect(screen.getByText('128.00')).toBeInTheDocument();
    expect(
      within(getMetricItem('分类方案')).getByText('NDVI 默认'),
    ).toBeInTheDocument();
    expect(screen.getByText('0.20 ~ 0.40')).toBeInTheDocument();
    expect(screen.getByLabelText('像元分级颜色')).toBeInTheDocument();
    expect(screen.getByText('r10-c20')).toBeInTheDocument();
  });

  it('formats geographic hover coordinates with six decimals', () => {
    act(() => {
      useRasterStore.getState().setMetadata(
        createRasterMetadata({
          boundingBox: [119.420001, 36.510001, 119.420901, 36.510601],
          crsCode: 'EPSG:4326',
          cellSize: { x: 0.0000004, y: 0.0000004, unit: 'degree' },
          isProjected: false,
        }),
      );
      useMapUiStore.getState().setHoverInfo({
        coordinate: [119.420456, 36.510654],
        pixel: { row: 3, col: 4 },
        sampleValues: [5],
        classificationLayerName: null,
        classificationLabel: null,
        classificationColor: null,
        inValidityMask: null,
        inFence: false,
        gridCellId: null,
        gridMeanValue: null,
        gridValidPixelCount: null,
      });
    });

    render(<RightPanel />);

    expect(
      within(getMetricItem('坐标')).getByText('119.420456, 36.510654'),
    ).toBeInTheDocument();
  });

  it('shows placeholders when hover info has no visible classification layer', () => {
    act(() => {
      useMapUiStore.getState().setHoverInfo({
        coordinate: [1, 2],
        pixel: { row: 3, col: 4 },
        sampleValues: [5],
        classificationLayerName: null,
        classificationLabel: null,
        classificationColor: null,
        inValidityMask: null,
        inFence: false,
        gridCellId: null,
        gridMeanValue: null,
        gridValidPixelCount: null,
      });
    });

    render(<RightPanel />);

    expect(screen.getByText('1.00, 2.00')).toBeInTheDocument();
    expect(screen.getByText('3 / 4')).toBeInTheDocument();
    expect(screen.getByText('5.00')).toBeInTheDocument();
    expect(within(getMetricItem('分类方案')).getByText('--')).toBeInTheDocument();
    expect(within(getMetricItem('分级区间')).getByText('--')).toBeInTheDocument();
    expect(within(getMetricItem('分级颜色')).getByText('--')).toBeInTheDocument();
    expect(within(getMetricItem('网格命中')).getByText('--')).toBeInTheDocument();
    expect(within(getMetricItem('网格均值')).getByText('--')).toBeInTheDocument();
    expect(within(getMetricItem('有效像元数')).getByText('--')).toBeInTheDocument();
  });

  it('shows aggregated grid mean and valid pixel count in hover diagnostics', () => {
    act(() => {
      useMapUiStore.getState().setHoverInfo({
        coordinate: [1, 2],
        pixel: { row: 3, col: 4 },
        sampleValues: [0.13],
        classificationLayerName: null,
        classificationLabel: null,
        classificationColor: null,
        inValidityMask: null,
        inFence: false,
        gridCellId: 'r10-c20',
        gridMeanValue: 0.62,
        gridValidPixelCount: 18,
      });
    });

    render(<RightPanel />);

    expect(within(getMetricItem('像元值')).getByText('0.13')).toBeInTheDocument();
    expect(within(getMetricItem('网格均值')).getByText('0.62')).toBeInTheDocument();
    expect(within(getMetricItem('有效像元数')).getByText('18')).toBeInTheDocument();
  });
});
