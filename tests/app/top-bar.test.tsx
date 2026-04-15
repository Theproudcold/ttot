import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { TopBar } from '@/app/layout/TopBar';
import { useFenceStore } from '@/features/fence/fenceStore';
import { useGridStore } from '@/features/grid/gridStore';
import { useLoadingStore } from '@/features/loading/loadingStore';
import { useRasterStore } from '@/features/map/rasterStore';

describe('TopBar', () => {
  afterEach(() => {
    act(() => {
      useRasterStore.getState().reset();
      useFenceStore.getState().reset();
      useGridStore.getState().reset();
      useLoadingStore.getState().stop();
    });
  });

  it('renders title and export actions', () => {
    render(<TopBar />);

    expect(screen.getByText('GeoTIFF 围栏网格工具')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导出围栏' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导出网格' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导出 GeoTIFF' })).toBeInTheDocument();
  });

  it('disables export buttons when no data is available', () => {
    render(<TopBar />);

    expect(screen.getByRole('button', { name: '导出围栏' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '导出网格' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '导出 GeoTIFF' })).toBeDisabled();
  });

  it('enables export buttons when relevant data exists', () => {
    act(() => {
      useRasterStore.getState().selectFile(new File([], 'test.tif'));
      useFenceStore.getState().setFence([
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ]);
      useGridStore.getState().setSummary({
        cellSize: 1,
        rows: 2,
        cols: 2,
        totalCells: 4,
        previewCellCount: 4,
        isPreviewLimited: false,
        previewStride: 1,
        rotation: 0,
      });
      useGridStore.getState().setPreview(
        [
          {
            id: 'r0-c0',
            row: 0,
            col: 0,
            center: [0.25, 0.25],
            polygon: [
              [
                [0, 0],
                [0.5, 0],
                [0.5, 0.5],
                [0, 0.5],
                [0, 0],
              ],
            ],
          },
        ],
        {
          cellSize: 1,
          rows: 2,
          cols: 2,
          totalCells: 4,
          previewCellCount: 4,
          isPreviewLimited: false,
          previewStride: 1,
          warning: null,
          rotation: 0,
        },
      );
    });

    render(<TopBar />);

    expect(screen.getByRole('button', { name: '导出围栏' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '导出网格' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '导出 GeoTIFF' })).toBeEnabled();
  });
});
