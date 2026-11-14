import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TopBar } from '@/app/layout/TopBar';
import { useFenceStore } from '@/features/fence/fenceStore';
import { useGridStore } from '@/features/grid/gridStore';
import { useLoadingStore } from '@/features/loading/loadingStore';
import { useMapUiStore } from '@/features/map/mapUiStore';
import { useRasterStore } from '@/features/map/rasterStore';
import {
  exportProjectSnapshot,
  type ExportProjectSnapshotInput,
} from '@/features/project/projectSnapshot';
import { createMetricTransform } from '@/shared/geo/crs';
import type { RasterMetadata } from '@/shared/types/raster';

const { downloadProjectFileMock, readProjectFileMock } = vi.hoisted(() => ({
  downloadProjectFileMock: vi.fn(),
  readProjectFileMock: vi.fn(),
}));

vi.mock('@/features/project/projectFile', () => ({
  downloadProjectFile: downloadProjectFileMock,
  readProjectFile: readProjectFileMock,
}));

function createRasterMetadata(
  overrides: Partial<RasterMetadata> & Pick<RasterMetadata, 'boundingBox' | 'crsCode'>,
): RasterMetadata {
  const { boundingBox, crsCode, ...rest } = overrides;
  const metricTransform = createMetricTransform({ crsCode, boundingBox });

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

function makeSnapshot(overrides: Partial<ExportProjectSnapshotInput> = {}) {
  return exportProjectSnapshot({
    sourceFile: null,
    sourceLabel: '未选择文件',
    metadata: null,
    fenceRings: [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
    ],
    grid: { cellSize: 5, rotation: 30, aggregationMode: 'max' },
    classification: { layers: [], activeLayerId: null, visibleLayerId: null },
    view: {
      layers: { raster: true, fence: true, grid: true },
      gridRenderSettings: {
        useClassificationColors: true,
        fillColor: '#3388ff',
        fillOpacity: 0.3,
        strokeColor: '#3388ff',
        strokeOpacity: 0.8,
        strokeWidth: 1,
      },
    },
    ...overrides,
  });
}

describe('TopBar', () => {
  beforeEach(() => {
    downloadProjectFileMock.mockReset();
    readProjectFileMock.mockReset();
  });

  afterEach(() => {
    act(() => {
      useRasterStore.getState().reset();
      useFenceStore.getState().reset();
      useGridStore.getState().reset();
      useMapUiStore.getState().reset();
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
        warning: null,
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

  it('saves the current setup as a project file', () => {
    downloadProjectFileMock.mockReturnValue('demo-project.ttot.json');

    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: '保存工程' }));

    expect(downloadProjectFileMock).toHaveBeenCalledTimes(1);
    const snapshot = downloadProjectFileMock.mock.calls[0]?.[0];
    expect(snapshot.kind).toBe('ttot-project');
    expect(screen.getByText(/工程已保存：demo-project\.ttot\.json/)).toBeInTheDocument();
  });

  it('opens a project file and applies its settings', async () => {
    const snapshot = makeSnapshot();
    readProjectFileMock.mockResolvedValue({ ok: true, snapshot, warnings: [] });

    render(<TopBar />);

    const input = document.getElementById('project-file-input') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['{}'], 'demo.ttot.json', { type: 'application/json' })] },
    });

    await waitFor(() => expect(useGridStore.getState().cellSize).toBe(5));
    expect(useGridStore.getState().rotation).toBe(30);
    expect(useGridStore.getState().aggregationMode).toBe('max');
    expect(useFenceStore.getState().fence).not.toBeNull();
    expect(screen.getByText('工程已打开')).toBeInTheDocument();
  });

  it('reports a broken project file instead of applying it', async () => {
    readProjectFileMock.mockResolvedValue({ ok: false, errors: ['工程文件不是合法的 JSON。'] });

    render(<TopBar />);

    const input = document.getElementById('project-file-input') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['{'], 'broken.ttot.json', { type: 'application/json' })] },
    });

    await waitFor(() =>
      expect(screen.getByText(/工程文件无法打开/)).toBeInTheDocument(),
    );
    expect(useGridStore.getState().cellSize).toBe(1);
  });

  it('refuses a project whose fence falls outside the loaded raster', async () => {
    const snapshot = makeSnapshot({
      sourceFile: new File(['x'], 'source.tif', { type: 'image/tiff' }),
      sourceLabel: 'source.tif',
      metadata: createRasterMetadata({ boundingBox: [0, 0, 200, 200], crsCode: 'EPSG:4549' }),
    });
    readProjectFileMock.mockResolvedValue({ ok: true, snapshot, warnings: [] });

    // 当前影像只有 20×20，围栏落在 0..10 之外的位置
    act(() => {
      useRasterStore.getState().setMetadata(
        createRasterMetadata({ boundingBox: [500, 500, 520, 520], crsCode: 'EPSG:4549' }),
      );
    });

    render(<TopBar />);

    const input = document.getElementById('project-file-input') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['{}'], 'demo.ttot.json', { type: 'application/json' })] },
    });

    await waitFor(() =>
      expect(screen.getByText(/围栏超出影像范围/)).toBeInTheDocument(),
    );
    expect(useGridStore.getState().cellSize).toBe(1);
  });
});
