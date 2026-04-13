import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LeftPanel } from '@/app/layout/LeftPanel';
import { useFenceStore } from '@/features/fence/fenceStore';
import { useGridStore } from '@/features/grid/gridStore';

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

describe('ExportControls', () => {
  afterEach(() => {
    act(() => {
      useFenceStore.getState().reset();
      useGridStore.getState().reset();
    });
    downloadGeoJson.mockReset();
  });

  it('disables export buttons when no preview data exists', () => {
    render(<LeftPanel />);

    expect(screen.getByRole('button', { name: '导出围栏' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '导出网格' })).toBeDisabled();
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
        },
      );
    });

    render(<LeftPanel />);

    const exportGridButton = screen.getByRole('button', { name: '导出网格' });
    expect(exportGridButton).toBeEnabled();

    fireEvent.click(exportGridButton);

    expect(downloadGeoJson).toHaveBeenCalledTimes(1);
  });
});
