import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TopBar } from '@/app/layout/TopBar';
import { downloadExportedGeoTiff, exportFenceGeoTiff } from '@/features/export/geoTiffExportJob';
import { useFenceStore } from '@/features/fence/fenceStore';
import { useGridStore } from '@/features/grid/gridStore';
import { useLoadingStore } from '@/features/loading/loadingStore';
import { useRasterStore } from '@/features/map/rasterStore';

const { downloadGeoJson } = vi.hoisted(() => ({
  downloadGeoJson: vi.fn(),
}));

vi.mock('@/features/export/exportGeoJson', async () => {
  const actual = await vi.importActual<typeof import('@/features/export/exportGeoJson')>(
    '@/features/export/exportGeoJson',
  );

  return {
    ...actual,
    downloadGeoJson,
  };
});

vi.mock('@/features/export/geoTiffExportJob', () => ({
  exportFenceGeoTiff: vi.fn(),
  downloadExportedGeoTiff: vi.fn(),
}));

describe('ExportControls', () => {
  afterEach(() => {
    act(() => {
      useFenceStore.getState().reset();
      useGridStore.getState().reset();
      useRasterStore.getState().reset();
      useLoadingStore.getState().stop();
    });
    downloadGeoJson.mockReset();
    vi.mocked(exportFenceGeoTiff).mockReset();
    vi.mocked(downloadExportedGeoTiff).mockReset();
  });

  it('disables export buttons when no preview data exists', () => {
    render(<TopBar />);

    expect(screen.getByRole('button', { name: '导出围栏' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '导出网格' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '导出 GeoTIFF' })).toBeDisabled();
  });

  it('enables export buttons and triggers grid export when data exists', () => {
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
      useGridStore.getState().setPreview(
        [
          {
            id: 'r0-c0',
            row: 0,
            col: 0,
            center: [2.5, 2.5],
            polygon: [
              [
                [0, 0],
                [5, 0],
                [5, 5],
                [0, 5],
                [0, 0],
              ],
            ],
          },
        ],
        {
          cellSize: 5,
          rows: 4,
          cols: 2,
          totalCells: 1,
          previewCellCount: 1,
          isPreviewLimited: false,
          previewStride: 1,
          warning: null,
          rotation: 0,
        },
      );
    });

    render(<TopBar />);

    const exportGridButton = screen.getByRole('button', { name: '导出网格' });
    expect(exportGridButton).toBeEnabled();

    fireEvent.click(exportGridButton);

    expect(downloadGeoJson).toHaveBeenCalledTimes(1);
  });

  it('shows exporting state while geotiff export is pending', () => {
    vi.mocked(exportFenceGeoTiff).mockReturnValue(new Promise(() => undefined));

    act(() => {
      useRasterStore.getState().selectFile(new File(['demo'], 'test2.tif', { type: 'image/tiff' }));
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

    render(<TopBar />);

    fireEvent.click(screen.getByRole('button', { name: '导出 GeoTIFF' }));

    expect(screen.getByRole('button', { name: '处理中...' })).toBeDisabled();
  });

  it('shows success and failure messages for geotiff export', async () => {
    act(() => {
      useRasterStore.getState().selectFile(new File(['demo'], 'test2.tif', { type: 'image/tiff' }));
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

    vi.mocked(exportFenceGeoTiff).mockResolvedValueOnce({
      blob: new Blob(['demo'], { type: 'image/tiff' }),
      filename: 'test2-clipped.tif',
      warnings: [],
    });
    vi.mocked(downloadExportedGeoTiff).mockResolvedValueOnce();

    render(<TopBar />);

    fireEvent.click(screen.getByRole('button', { name: '导出 GeoTIFF' }));

    await waitFor(() => {
      expect(screen.getByText('GeoTIFF 导出完成')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '导出 GeoTIFF' })).toBeEnabled();
    });

    vi.mocked(exportFenceGeoTiff).mockRejectedValueOnce(new Error('围栏超出影像范围'));

    fireEvent.click(screen.getByRole('button', { name: '导出 GeoTIFF' }));

    await waitFor(() => {
      expect(screen.getByText('GeoTIFF 导出失败：围栏超出影像范围')).toBeInTheDocument();
    });
  });

  it('embeds the current project snapshot and surfaces embed warnings', async () => {
    act(() => {
      useRasterStore.getState().selectFile(new File(['demo'], 'test2.tif', { type: 'image/tiff' }));
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

    vi.mocked(exportFenceGeoTiff).mockResolvedValueOnce({
      blob: new Blob(['demo'], { type: 'image/tiff' }),
      filename: 'test2-clipped.tif',
      warnings: ['设置过大（约 40KB），已跳过内嵌，请另存工程文件。'],
    });
    vi.mocked(downloadExportedGeoTiff).mockResolvedValueOnce();

    render(<TopBar />);

    fireEvent.click(screen.getByRole('button', { name: '导出 GeoTIFF' }));

    await waitFor(() => {
      expect(screen.getByText(/已跳过内嵌/)).toBeInTheDocument();
    });

    // 导出必须带上配方，否则导出文件无法还原设置
    const call = vi.mocked(exportFenceGeoTiff).mock.calls[0]?.[0];
    expect(call?.projectSnapshot?.kind).toBe('ttot-project');
    expect(call?.projectSnapshot?.fence?.rings).toHaveLength(1);
    expect(call?.projectSnapshot?.grid.cellSize).toBe(useGridStore.getState().cellSize);
  });
});
