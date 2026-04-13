import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { LeftPanel } from '@/app/layout/LeftPanel';
import { useFenceStore } from '@/features/fence/fenceStore';
import { useGridStore } from '@/features/grid/gridStore';
import { useRasterStore } from '@/features/map/rasterStore';

describe('LeftPanel', () => {
  afterEach(() => {
    act(() => {
      useRasterStore.getState().reset();
      useFenceStore.getState().reset();
      useGridStore.getState().reset();
    });
  });

  it('renders loaded raster metadata from store', () => {
    act(() => {
      useRasterStore.getState().setMetadata({
        sourceUrl: '/assets/test2.tif',
        fileName: 'test2.tif',
        width: 5647,
        height: 3179,
        samplesPerPixel: 1,
        boundingBox: [447934.5768945037, 4041573.0550815426, 448017.5877945037, 4041619.7863815427],
        origin: [447934.5768945037, 4041619.7863815427, 0],
        resolution: [0.0147, -0.0147, 0],
        cellSize: {
          x: 0.0147,
          y: 0.0147,
          unit: 'm',
        },
        crsCode: 'EPSG:4549',
        crsName: 'CGCS2000 / 3-degree Gauss-Kruger CM 120E',
        isProjected: true,
      });
    });

    render(<LeftPanel />);

    expect(screen.getByText('5647 x 3179')).toBeInTheDocument();
    expect(screen.getByText('EPSG:4549')).toBeInTheDocument();
    expect(screen.getByText('0.0147 m')).toBeInTheDocument();
    expect(screen.getByText('83.01m x 46.73m')).toBeInTheDocument();
  });

  it('shows fence toolbar actions and current mode', () => {
    act(() => {
      useFenceStore.getState().startDraw();
    });

    render(<LeftPanel />);

    expect(screen.getByRole('button', { name: '开始绘制' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '编辑围栏' })).toBeInTheDocument();
    expect(screen.getByText('当前模式：draw')).toBeInTheDocument();
  });

  it('shows grid parameters and estimated cell count', () => {
    act(() => {
      useGridStore.getState().setCellSize(0.5);
      useGridStore.getState().setSummary({
        cellSize: 0.5,
        rows: 200,
        cols: 200,
        totalCells: 40000,
        previewCellCount: 10000,
        isPreviewLimited: true,
        previewStride: 2,
        warning: '网格过密，当前按 2x2 抽样预览。',
      });
    });

    render(<LeftPanel />);

    expect(screen.getByDisplayValue('0.5')).toBeInTheDocument();
    expect(screen.getByText('预计网格：40000')).toBeInTheDocument();
  });

  it('shows upload control instead of default bundled tif', () => {
    render(<LeftPanel />);

    expect(screen.getByLabelText('选择 TIFF 文件')).toBeInTheDocument();
    expect(screen.getByText('未选择文件')).toBeInTheDocument();
  });

  it('uses 10 meters as the default grid cell size', () => {
    render(<LeftPanel />);

    expect(screen.getByDisplayValue('10')).toBeInTheDocument();
  });

  it('renders raster classification controls with a default step of 0.2', () => {
    render(<LeftPanel />);

    expect(screen.getByLabelText('渲染最小值')).toBeInTheDocument();
    expect(screen.getByLabelText('渲染最大值')).toBeInTheDocument();
    expect(screen.getByLabelText('分级步长')).toHaveDisplayValue('0.2');
  });
});
