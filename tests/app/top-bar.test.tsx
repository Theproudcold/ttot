import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { TopBar } from '@/app/layout/TopBar';
import { useRasterStore } from '@/features/map/rasterStore';

describe('TopBar', () => {
  afterEach(() => {
    act(() => {
      useRasterStore.getState().reset();
    });
  });

  it('renders loading progress when raster is being fetched', () => {
    act(() => {
      useRasterStore.getState().setLoadingProgress('正在读取 GeoTIFF', 42);
    });

    render(<TopBar />);

    expect(screen.getByText('读取进度：42%')).toBeInTheDocument();
    expect(screen.getByText('状态：正在读取 GeoTIFF')).toBeInTheDocument();
  });

  it('shows no default file before user uploads one', () => {
    render(<TopBar />);

    expect(screen.getByText('当前文件：未选择文件')).toBeInTheDocument();
  });
});
