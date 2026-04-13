import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import App from '@/app/App';

describe('App', () => {
  it('renders the workspace shell with core panels', () => {
    render(<App />);

    expect(screen.getByText('GeoTIFF 围栏网格工具')).toBeInTheDocument();
    expect(screen.getByText('文件信息')).toBeInTheDocument();
    expect(screen.getByText('地图工作区')).toBeInTheDocument();
    expect(screen.getByText('当前结果')).toBeInTheDocument();
  });
});
