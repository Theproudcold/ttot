import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { RightPanel } from '@/app/layout/RightPanel';
import { useFenceStore } from '@/features/fence/fenceStore';
import { useGridStore } from '@/features/grid/gridStore';
import { useMapUiStore } from '@/features/map/mapUiStore';
import { useRasterStore } from '@/features/map/rasterStore';

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
      });
    });

    render(<RightPanel />);

    expect(screen.getByText('10000')).toBeInTheDocument();
  });

  it('renders fence and grid warnings when preview is downgraded or fence is invalid', () => {
    act(() => {
      useFenceStore.getState().setValidationMessage('围栏必须落在影像有效数据范围内');
      useGridStore.getState().setSummary({
        cellSize: 0.1,
        rows: 200,
        cols: 200,
        totalCells: 40000,
        previewCellCount: 4489,
        isPreviewLimited: true,
        previewStride: 3,
        warning: '网格过密，当前按 3x3 抽样预览。',
      });
    });

    render(<RightPanel />);

    expect(screen.getByText('围栏必须落在影像有效数据范围内')).toBeInTheDocument();
    expect(screen.getByText('网格过密，当前按 3x3 抽样预览。')).toBeInTheDocument();
  });

  it('shows raster physical size and grid ratios when metadata exists', () => {
    act(() => {
      useRasterStore.getState().setMetadata({
        sourceUrl: null,
        fileName: 'test2.tif',
        width: 5647,
        height: 3179,
        samplesPerPixel: 1,
        boundingBox: [447934.5768945037, 4041573.0550815426, 448017.5877945037, 4041619.7863815427],
        origin: [447934.5768945037, 4041619.7863815427, 0],
        resolution: [0.0147, -0.0147, 0],
        cellSize: { x: 0.0147, y: 0.0147, unit: 'm' },
        crsCode: 'EPSG:4549',
        crsName: 'CGCS2000 / 3-degree Gauss-Kruger CM 120E',
        isProjected: true,
      });
      useGridStore.getState().setCellSize(10);
    });

    render(<RightPanel />);

    expect(screen.getByText('83.01m x 46.73m')).toBeInTheDocument();
    expect(screen.getByText('12.0% / 21.4%')).toBeInTheDocument();
  });

  it('renders layer toggles and hover diagnostics', () => {
    act(() => {
      useMapUiStore.getState().toggleLayer('grid');
      useMapUiStore.getState().setHoverInfo({
        coordinate: [447976.08, 4041596.42],
        pixel: { row: 1590, col: 2823 },
        sampleValues: [128],
        classificationLabel: '0.20 ~ 0.40',
        classificationColor: '#777777',
        inValidityMask: true,
        inFence: false,
        gridCellId: 'r10-c20',
      });
    });

    render(<RightPanel />);

    expect(screen.getByLabelText('切换影像图层')).toBeChecked();
    expect(screen.getByLabelText('切换围栏图层')).toBeChecked();
    expect(screen.getByLabelText('切换网格图层')).not.toBeChecked();
    expect(screen.getByText('447976.08, 4041596.42')).toBeInTheDocument();
    expect(screen.getByText('1590 / 2823')).toBeInTheDocument();
    expect(screen.getByText('128.00')).toBeInTheDocument();
    expect(screen.getByText('0.20 ~ 0.40')).toBeInTheDocument();
    expect(screen.getByLabelText('像元分级颜色')).toBeInTheDocument();
    expect(screen.getByText('r10-c20')).toBeInTheDocument();
  });
});
