import { beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeEmbeddedSnapshot, exportProjectSnapshot } from '@/features/project/projectSnapshot';
import { readEmbeddedProjectSnapshot } from '@/features/project/readEmbeddedSnapshot';
import { resetRasterSessionCache } from '@/shared/geo/rasterIo';

const { fromArrayBufferMock } = vi.hoisted(() => ({
  fromArrayBufferMock: vi.fn(),
}));

vi.mock('geotiff', () => ({
  fromArrayBuffer: fromArrayBufferMock,
}));

function makeSnapshot() {
  return exportProjectSnapshot({
    sourceFile: null,
    sourceLabel: '未选择文件',
    metadata: null,
    fenceRings: [
      [
        [0, 0],
        [3, 0],
        [3, 3],
        [0, 3],
        [0, 0],
      ],
    ],
    grid: { cellSize: 1.5, rotation: 12, aggregationMode: 'min' },
    classification: {
      layers: [
        {
          id: 'rules-a',
          label: '规则方案',
          noDataColor: '#00000000',
          visible: true,
          mode: 'rules',
          gradientStops: [],
          rules: [{ min: 0, max: null, color: '#226622', label: '高值', applicationRate: 8 }],
        },
      ],
      activeLayerId: 'rules-a',
      visibleLayerId: 'rules-a',
    },
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
}

function stubImage(fileDirectory: Record<string, unknown>) {
  fromArrayBufferMock.mockResolvedValue({
    getImage: vi.fn().mockResolvedValue({
      getFileDirectory: () => fileDirectory,
    }),
  });
}

beforeEach(() => {
  fromArrayBufferMock.mockReset();
  resetRasterSessionCache();
});

describe('readEmbeddedProjectSnapshot', () => {
  it('decodes a snapshot embedded by this tool', async () => {
    const snapshot = makeSnapshot();
    // 真实读回时 ASCII tag 会带尾部 NUL
    stubImage({ ImageDescription: `${encodeEmbeddedSnapshot(snapshot)}\0` });

    const result = await readEmbeddedProjectSnapshot(
      new File(['x'], 'exported.tif', { type: 'image/tiff' }),
    );

    expect(result?.ok).toBe(true);
    if (!result || !result.ok) return;
    expect(result.snapshot).toEqual(snapshot);
  });

  it('returns null for a third-party geotiff', async () => {
    stubImage({ ImageDescription: 'GDAL 3.9.0, released 2024/05/07' });

    const result = await readEmbeddedProjectSnapshot(
      new File(['x'], 'external.tif', { type: 'image/tiff' }),
    );

    expect(result).toBeNull();
  });

  it('returns null when the file carries no ImageDescription', async () => {
    stubImage({ PhotometricInterpretation: 1 });

    const result = await readEmbeddedProjectSnapshot(
      new File(['x'], 'plain.tif', { type: 'image/tiff' }),
    );

    expect(result).toBeNull();
  });

  it('reports a damaged payload as a parse failure, not as absent', async () => {
    stubImage({ ImageDescription: 'TTOT1:!!!!\0' });

    const result = await readEmbeddedProjectSnapshot(
      new File(['x'], 'broken.tif', { type: 'image/tiff' }),
    );

    expect(result).not.toBeNull();
    expect(result?.ok).toBe(false);
  });
});
