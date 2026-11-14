import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LeftPanel } from '@/app/layout/LeftPanel';
import { useFenceStore } from '@/features/fence/fenceStore';
import { useGridStore } from '@/features/grid/gridStore';
import { useMapUiStore } from '@/features/map/mapUiStore';
import { useRasterStore } from '@/features/map/rasterStore';
import { exportProjectSnapshot } from '@/features/project/projectSnapshot';
import { createMetricTransform } from '@/shared/geo/crs';
import type { RasterMetadata } from '@/shared/types/raster';

const { readEmbeddedProjectSnapshotMock } = vi.hoisted(() => ({
  readEmbeddedProjectSnapshotMock: vi.fn(),
}));

vi.mock('@/features/project/readEmbeddedSnapshot', () => ({
  readEmbeddedProjectSnapshot: readEmbeddedProjectSnapshotMock,
}));

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

describe('LeftPanel', () => {
  beforeEach(() => {
    // 默认：选中的影像没有内嵌配方
    readEmbeddedProjectSnapshotMock.mockResolvedValue(null);
  });

  afterEach(() => {
    act(() => {
      useRasterStore.getState().reset();
      useFenceStore.getState().reset();
      useGridStore.getState().reset();
      useMapUiStore.getState().reset();
    });
    readEmbeddedProjectSnapshotMock.mockReset();
    vi.useRealTimers();
  });

  it('renders projected raster metadata with original extent, metric size and grid ratio', () => {
    act(() => {
      useRasterStore.getState().setMetadata(
        createRasterMetadata({
          sourceUrl: '/assets/test2.tif',
          fileName: 'test2.tif',
          width: 5647,
          height: 3179,
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
        }),
      );
      useGridStore.getState().setCellSize(10);
    });

    render(<LeftPanel />);

    expect(screen.getByText('5647 x 3179')).toBeInTheDocument();
    expect(screen.getByText('EPSG:4549')).toBeInTheDocument();
    expect(screen.getByText('0.0147 m')).toBeInTheDocument();
    expect(screen.getByText('447934.58, 4041573.06, 448017.59, 4041619.79')).toBeInTheDocument();
    expect(screen.getByText('83.01m x 46.73m')).toBeInTheDocument();
    expect(screen.getByText('12.0% / 21.4%')).toBeInTheDocument();
  });

  it('shows geographic source extent and metric dimensions side by side', () => {
    act(() => {
      useRasterStore.getState().setMetadata(
        createRasterMetadata({
          fileName: 'gps-ndvi.tif',
          width: 2250,
          height: 1500,
          boundingBox: [119.420001, 36.510001, 119.420901, 36.510601],
          origin: [119.420001, 36.510601, 0],
          resolution: [0.0000004, -0.0000004, 0],
          cellSize: {
            x: 0.0000004,
            y: 0.0000004,
            unit: 'degree',
          },
          crsCode: 'EPSG:4326',
          crsName: 'EPSG:4326',
          isProjected: false,
        }),
      );
      useGridStore.getState().setCellSize(10);
    });

    render(<LeftPanel />);

    expect(screen.getByText('EPSG:4326')).toBeInTheDocument();
    expect(screen.getByText('119.420001, 36.510001, 119.420901, 36.510601')).toBeInTheDocument();
    expect(screen.getByText('80.53m x 66.79m')).toBeInTheDocument();
    expect(screen.getByText('12.4% / 15.0%')).toBeInTheDocument();
  });

  it('shows fence toolbar actions and current mode', () => {
    act(() => {
      useFenceStore.getState().startDraw();
    });

    render(<LeftPanel />);

    expect(screen.getByRole('button', { name: '绘制中…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '编辑围栏' })).toBeInTheDocument();
    expect(screen.getByText('正在绘制：单击地图添加顶点，双击完成绘制。')).toBeInTheDocument();
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
        rotation: 0,
      });
    });

    render(<LeftPanel />);

    expect(screen.getByDisplayValue('0.5')).toBeInTheDocument();
    expect(
      within(screen.getByText('预计网格').closest('.metric-item') as HTMLElement).getByText('40000'),
    ).toBeInTheDocument();
  });

  it('shows upload control instead of default bundled tif', () => {
    render(<LeftPanel />);

    expect(screen.getByLabelText('选择 TIFF 文件')).toBeInTheDocument();
    expect(screen.getByText('未选择文件')).toBeInTheDocument();
  });

  it('uses 1 meter as the default grid cell size', () => {
    render(<LeftPanel />);

    expect(screen.getByLabelText('网格尺寸（米）')).toHaveDisplayValue('1');
  });

  it('keeps the default grid cell size after reset even when a stale debounced value exists', () => {
    vi.useFakeTimers();

    render(<LeftPanel />);

    const input = screen.getByLabelText('网格尺寸（米）');

    fireEvent.change(input, { target: { value: '0.5' } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(useGridStore.getState().cellSize).toBe(0.5);

    act(() => {
      useGridStore.getState().reset();
    });

    expect(useGridStore.getState().cellSize).toBe(1);
    expect(screen.getByLabelText('网格尺寸（米）')).toHaveDisplayValue('1');
  });

  it('shows loading progress when local file parsing is in flight', () => {
    act(() => {
      useRasterStore.getState().setLoadingProgress('正在读取本地文件', 42);
    });

    render(<LeftPanel />);

    expect(
      within(screen.getByText('读取进度').closest('.metric-item') as HTMLElement).getByText('42%'),
    ).toBeInTheDocument();
  });

  it('clamps cell size to the minimum allowed by raster resolution', () => {
    vi.useFakeTimers();

    act(() => {
      useRasterStore.getState().setMetadata(
        createRasterMetadata({
          fileName: 'high-res.tif',
          width: 1000,
          height: 1000,
          boundingBox: [0, 0, 100, 100],
          cellSize: { x: 0.5, y: 0.5, unit: 'm' },
          crsCode: 'EPSG:4549',
        }),
      );
    });

    render(<LeftPanel />);

    const input = screen.getByLabelText('网格尺寸（米）') as HTMLInputElement;
    expect(input.min).toBe('0.5');
    expect(screen.getByText('最小网格尺寸受影像分辨率限制为 0.5000 米')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '0.1' } });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(useGridStore.getState().cellSize).toBe(0.5);
    expect(input).toHaveDisplayValue('0.5');
  });

  it('falls back to absolute minimum when no metadata is available', () => {
    vi.useFakeTimers();

    render(<LeftPanel />);

    const input = screen.getByLabelText('网格尺寸（米）') as HTMLInputElement;
    expect(input.min).toBe('0.01');

    fireEvent.change(input, { target: { value: '0.001' } });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(useGridStore.getState().cellSize).toBe(0.01);
    expect(input).toHaveDisplayValue('0.01');
  });

  it('keeps the existing fence and grid when a new raster is selected', () => {
    // 这正是"导入自己导出的文件后一切归零"那条反馈的回归测试
    act(() => {
      useFenceStore.getState().setFence([
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
      ]);
      useGridStore.getState().setCellSize(4);
    });

    render(<LeftPanel />);

    const input = document.getElementById('raster-file-input') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'new.tif', { type: 'image/tiff' })] },
    });

    expect(useFenceStore.getState().fence).not.toBeNull();
    expect(useGridStore.getState().cellSize).toBe(4);
  });

  it('imports a fence from a GeoJSON file', async () => {
    const rings = [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
    ];
    const geojson = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: rings } },
      ],
    };

    render(<LeftPanel />);

    const input = document.getElementById('fence-geojson-input') as HTMLInputElement;

    fireEvent.change(input, {
      target: {
        files: [
          new File([JSON.stringify(geojson)], 'fence.geojson', { type: 'application/geo+json' }),
        ],
      },
    });

    // 读取走 FileReader，其回调不在微任务队列里，必须等它真正完成
    await waitFor(() =>
      expect(useFenceStore.getState().fence?.geometry.coordinates).toEqual(rings),
    );
    expect(screen.getByLabelText('import-notice').textContent).toContain('已导入围栏');
  });

  it('reports why a grid GeoJSON cannot be used as a fence', async () => {
    const cell = [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0],
      ],
    ];
    const gridFile = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: cell } },
        { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: cell } },
      ],
    };

    render(<LeftPanel />);
    const input = document.getElementById('fence-geojson-input') as HTMLInputElement;

    fireEvent.change(input, {
      target: { files: [new File([JSON.stringify(gridFile)], 'grid.geojson', { type: 'application/geo+json' })] },
    });

    await waitFor(() =>
      expect(screen.getByLabelText('import-notice').textContent).toContain('网格导出'),
    );
    expect(useFenceStore.getState().fence).toBeNull();
  });

  it('offers to restore the project settings embedded in an exported TIFF', async () => {
    const snapshot = exportProjectSnapshot({
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
      grid: { cellSize: 3, rotation: 20, aggregationMode: 'max' },
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
    });
    readEmbeddedProjectSnapshotMock.mockResolvedValue({ ok: true, snapshot, warnings: [] });

    render(<LeftPanel />);

    const input = document.getElementById('raster-file-input') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, {
        target: { files: [new File(['x'], 'exported.tif', { type: 'image/tiff' })] },
      });
    });

    // 必须先确认，不能静默改设置
    expect(screen.getByLabelText('project-restore')).toBeInTheDocument();
    expect(useGridStore.getState().cellSize).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: '还原' }));

    expect(useGridStore.getState().cellSize).toBe(3);
    expect(useGridStore.getState().rotation).toBe(20);
    expect(useGridStore.getState().aggregationMode).toBe('max');
    expect(useFenceStore.getState().fence).not.toBeNull();
    expect(screen.queryByLabelText('project-restore')).not.toBeInTheDocument();
  });

  it('refuses to restore settings when the coordinate system differs', async () => {
    const snapshot = exportProjectSnapshot({
      sourceFile: new File(['x'], 'source.tif', { type: 'image/tiff' }),
      sourceLabel: 'source.tif',
      metadata: createRasterMetadata({
        boundingBox: [119.4, 36.5, 119.5, 36.6],
        crsCode: 'EPSG:4326',
        resolution: [0.0001, -0.0001, 0],
      }),
      fenceRings: [
        [
          [119.45, 36.55],
          [119.46, 36.55],
          [119.46, 36.56],
          [119.45, 36.56],
          [119.45, 36.55],
        ],
      ],
      grid: { cellSize: 7, rotation: 0, aggregationMode: 'mean' },
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
    });
    readEmbeddedProjectSnapshotMock.mockResolvedValue({ ok: true, snapshot, warnings: [] });

    render(<LeftPanel />);
    const input = document.getElementById('raster-file-input') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, {
        target: { files: [new File(['x'], 'other.tif', { type: 'image/tiff' })] },
      });
    });

    // 真实加载顺序：提示出现时元信息尚未就绪，稍后才有坐标系。
    // 当前影像是投影坐标系，且范围足以覆盖围栏——因此这里只有 CRS 一项触发拦截。
    act(() => {
      useRasterStore.getState().setMetadata(
        createRasterMetadata({ boundingBox: [0, 0, 200, 200], crsCode: 'EPSG:4549', resolution: [1, -1, 0] }),
      );
    });

    fireEvent.click(screen.getByRole('button', { name: '还原' }));

    const notice = screen.getByLabelText('import-notice').textContent ?? '';
    expect(notice).toContain('坐标系不一致');
    expect(notice).not.toContain('围栏超出影像范围');
    // 坐标系不一致会导致网格整体偏移，宁可不还原
    expect(useGridStore.getState().cellSize).toBe(1);
  });

  it('leaves settings untouched when the embedded restore is declined', async () => {
    const snapshot = exportProjectSnapshot({
      sourceFile: null,
      sourceLabel: '未选择文件',
      metadata: null,
      fenceRings: null,
      grid: { cellSize: 9, rotation: 0, aggregationMode: 'mean' },
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
    });
    readEmbeddedProjectSnapshotMock.mockResolvedValue({ ok: true, snapshot, warnings: [] });

    render(<LeftPanel />);
    const input = document.getElementById('raster-file-input') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, {
        target: { files: [new File(['x'], 'exported.tif', { type: 'image/tiff' })] },
      });
    });

    fireEvent.click(screen.getByRole('button', { name: '忽略' }));

    expect(useGridStore.getState().cellSize).toBe(1);
    expect(screen.queryByLabelText('project-restore')).not.toBeInTheDocument();
  });
});
