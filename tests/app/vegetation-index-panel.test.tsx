import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VegetationIndexPanel } from '@/app/layout/right-panel/VegetationIndexPanel';
import { useMapUiStore } from '@/features/map/mapUiStore';
import { useRasterStore } from '@/features/map/rasterStore';
import type { RasterBandSamples } from '@/shared/geo/rasterBands';

const { loadRasterBandSamplesMock } = vi.hoisted(() => ({
  loadRasterBandSamplesMock: vi.fn(),
}));

vi.mock('@/shared/geo/rasterBands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/geo/rasterBands')>();

  return { ...actual, loadRasterBandSamples: loadRasterBandSamplesMock };
});

function makeSamples(overrides: Partial<RasterBandSamples> = {}): RasterBandSamples {
  return {
    width: 2,
    height: 2,
    sampleCount: 5,
    bands: [
      Float32Array.from([0.05, 0.06, 0.04, 0.05]), // 蓝
      Float32Array.from([0.2, 0.22, 0.18, 0.2]), // 绿
      Float32Array.from([0.1, 0.2, 0.4, 0.1]), // 红
      Float32Array.from([0.3, 0.35, 0.25, 0.3]), // 红边
      Float32Array.from([0.5, 0.6, 0.4, 0.5]), // 近红外
    ],
    metadataByBand: [
      { BANDNAME: 'Blue' },
      { BANDNAME: 'Green' },
      { BANDNAME: 'Red' },
      { BANDNAME: 'RedEdge' },
      { BANDNAME: 'NIR' },
    ],
    noDataValue: null,
    dataBandCount: 5,
    ...overrides,
  };
}

function mountPanel() {
  act(() => {
    useRasterStore.getState().selectFile(new File([], 'multi.tif', { type: 'image/tiff' }));
  });

  render(<VegetationIndexPanel />);
}

beforeEach(() => {
  loadRasterBandSamplesMock.mockReset();
});

afterEach(() => {
  act(() => {
    useRasterStore.getState().reset();
    useMapUiStore.getState().reset();
  });
});

describe('VegetationIndexPanel', () => {
  it('asks for an image first', () => {
    render(<VegetationIndexPanel />);

    expect(screen.getByText('请先载入影像，再计算植被指数。')).toBeInTheDocument();
  });

  it('explains why a single-band raster cannot produce an index', async () => {
    loadRasterBandSamplesMock.mockResolvedValue(
      makeSamples({
        sampleCount: 1,
        bands: [Float32Array.from([1, 2, 3, 4])],
        metadataByBand: [{}],
        dataBandCount: 1,
      }),
    );

    mountPanel();

    await waitFor(() => expect(screen.getByText(/单波段/)).toBeInTheDocument());
  });

  it('prefills the band assignment from metadata', async () => {
    loadRasterBandSamplesMock.mockResolvedValue(makeSamples());

    mountPanel();

    await waitFor(() => expect(screen.getByLabelText('近红外波段')).toBeInTheDocument());
    expect(screen.getByLabelText('近红外波段')).toHaveValue('4');
    expect(screen.getByLabelText('红波段')).toHaveValue('2');
    expect(screen.getByLabelText('红边波段')).toHaveValue('3');
    // 元数据可信时不应提示"请确认"
    expect(screen.queryByText(/请确认波段对应关系/)).not.toBeInTheDocument();
  });

  it('warns that a guessed assignment must be confirmed', async () => {
    loadRasterBandSamplesMock.mockResolvedValue(
      makeSamples({ metadataByBand: [{}, {}, {}, {}, {}] }),
    );

    mountPanel();

    // 5 波段无元数据 → 走厂商顺序推测 → 需要用户确认
    await waitFor(() =>
      expect(screen.getByText(/请确认波段对应关系/)).toBeInTheDocument(),
    );
  });

  it('generates an equal-area scheme and makes it the visible layer', async () => {
    loadRasterBandSamplesMock.mockResolvedValue(makeSamples());

    mountPanel();

    await waitFor(() => expect(screen.getByLabelText('分级数量')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('分级数量'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '生成分类方案' }));

    const state = useMapUiStore.getState();
    const generated = state.classificationLayers.find((layer) => layer.id.startsWith('index-ndvi-'));

    expect(generated).toBeDefined();
    expect(state.visibleClassificationLayerId).toBe(generated?.id);
    expect(state.activeClassificationLayerId).toBe(generated?.id);
    expect(generated?.mode).toBe('rules');
    if (generated?.mode !== 'rules') throw new Error('应当生成规则方案');
    expect(generated.rules.length).toBe(2);

    expect(screen.getByLabelText('vegetation-index-result')).toBeInTheDocument();
    expect(screen.getByLabelText('vegetation-index-message').textContent).toContain('已生成');
  });

  it('supports a custom formula and rejects an unsafe one', async () => {
    loadRasterBandSamplesMock.mockResolvedValue(makeSamples());

    mountPanel();

    await waitFor(() => expect(screen.getByLabelText('使用自定义公式')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('使用自定义公式'));
    fireEvent.change(screen.getByLabelText('分级数量'), { target: { value: '2' } });

    // 未知标识符必须被拒绝，而不是当成全局对象
    fireEvent.change(screen.getByLabelText(/可用波段/), { target: { value: 'ndvi * 2' } });
    fireEvent.click(screen.getByRole('button', { name: '生成分类方案' }));

    expect(screen.getByLabelText('vegetation-index-message').textContent).toContain('未知波段');
    expect(
      useMapUiStore.getState().classificationLayers.some((layer) => layer.id.startsWith('custom-index-')),
    ).toBe(false);

    // 合法公式可以生成
    fireEvent.change(screen.getByLabelText(/可用波段/), { target: { value: '(nir - red) / (nir + red)' } });
    fireEvent.click(screen.getByRole('button', { name: '生成分类方案' }));

    expect(
      useMapUiStore.getState().classificationLayers.some((layer) => layer.id.startsWith('custom-index-')),
    ).toBe(true);
  });

  it('reports when the data cannot be split', async () => {
    loadRasterBandSamplesMock.mockResolvedValue(
      makeSamples({
        bands: [
          Float32Array.from([0.1, 0.1, 0.1, 0.1]),
          Float32Array.from([0.1, 0.1, 0.1, 0.1]),
          Float32Array.from([0.1, 0.1, 0.1, 0.1]),
          Float32Array.from([0.1, 0.1, 0.1, 0.1]),
          Float32Array.from([0.1, 0.1, 0.1, 0.1]),
        ],
      }),
    );

    mountPanel();

    await waitFor(() => expect(screen.getByLabelText('分级数量')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '生成分类方案' }));

    expect(screen.getByLabelText('vegetation-index-message').textContent).toContain('无法分级');
    expect(
      useMapUiStore.getState().classificationLayers.some((layer) => layer.id.startsWith('index-')),
    ).toBe(false);
  });
});
