import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import App from '@/app/App';
import { useFenceStore } from '@/features/fence/fenceStore';
import { useGridStore } from '@/features/grid/gridStore';
import { useMapUiStore } from '@/features/map/mapUiStore';
import { useRasterStore } from '@/features/map/rasterStore';
import { writeDraft } from '@/features/project/draftStorage';
import { exportProjectSnapshot } from '@/features/project/projectSnapshot';

const FENCE_RINGS: [number, number][][] = [
  [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ],
];

function seedDraft() {
  writeDraft(
    exportProjectSnapshot({
      sourceFile: null,
      sourceLabel: '未选择文件',
      metadata: null,
      fenceRings: FENCE_RINGS,
      grid: { cellSize: 2.5, rotation: 30, aggregationMode: 'max' },
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
    }),
    { tabId: 'test-tab' },
  );
}

describe('App', () => {
  afterEach(() => {
    act(() => {
      useRasterStore.getState().reset();
      useFenceStore.getState().reset();
      useGridStore.getState().reset();
      useMapUiStore.getState().reset();
    });
    globalThis.localStorage.clear();
  });

  it('renders the workspace shell with core panels', () => {
    render(<App />);

    expect(screen.getByText('GeoTIFF 围栏网格工具')).toBeInTheDocument();
    expect(screen.getByText('文件信息')).toBeInTheDocument();
    expect(screen.getByText('地图工作区')).toBeInTheDocument();
    expect(screen.getByText('当前结果')).toBeInTheDocument();
  });

  it('does not restore a saved draft until the user confirms', () => {
    seedDraft();

    render(<App />);

    // 恢复必须由用户确认，不能静默生效
    expect(screen.getByText(/工作草稿/)).toBeInTheDocument();
    expect(useFenceStore.getState().fence).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '恢复' }));

    expect(useFenceStore.getState().fence?.geometry.coordinates).toEqual(FENCE_RINGS);
    expect(useGridStore.getState()).toMatchObject({
      cellSize: 2.5,
      rotation: 30,
      aggregationMode: 'max',
    });
    expect(screen.queryByText(/工作草稿/)).not.toBeInTheDocument();
  });

  it('discards the draft and keeps the current state when ignored', () => {
    seedDraft();

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '忽略' }));

    expect(useFenceStore.getState().fence).toBeNull();
    expect(screen.queryByText(/工作草稿/)).not.toBeInTheDocument();
  });
});
