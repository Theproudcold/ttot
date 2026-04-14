import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  loadRasterMetadataMock,
  loadRasterPreviewMock,
  loadRasterValidityMaskMock,
} = vi.hoisted(() => ({
  loadRasterMetadataMock: vi.fn(),
  loadRasterPreviewMock: vi.fn(),
  loadRasterValidityMaskMock: vi.fn(),
}));

vi.mock('@/shared/geo/raster', () => ({
  loadRasterMetadata: loadRasterMetadataMock,
  loadRasterPreview: loadRasterPreviewMock,
  loadRasterValidityMask: loadRasterValidityMaskMock,
}));

import { useRasterLoader } from '@/features/map/useRasterLoader';
import { useRasterStore } from '@/features/map/rasterStore';
import { createMetricTransform } from '@/shared/geo/crs';
import type { RasterMetadata, RasterPreview, RasterValidityMask } from '@/shared/types/raster';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}

function Harness() {
  useRasterLoader({ enabled: true });
  return null;
}

describe('useRasterLoader', () => {
  beforeEach(() => {
    loadRasterMetadataMock.mockReset();
    loadRasterPreviewMock.mockReset();
    loadRasterValidityMaskMock.mockReset();
  });

  afterEach(() => {
    act(() => {
      useRasterStore.getState().reset();
    });
  });

  it('keeps metadata, preview and validity loading alive after internal status updates', async () => {
    const metadataDeferred = createDeferred<RasterMetadata>();
    const previewDeferred = createDeferred<RasterPreview>();
    const validityDeferred = createDeferred<RasterValidityMask>();

    const boundingBox: [number, number, number, number] = [
      447934.5769,
      4041573.0551,
      448017.5878,
      4041619.7864,
    ];
    const metricTransform = createMetricTransform({
      crsCode: 'EPSG:4549',
      boundingBox,
    });
    const metadata: RasterMetadata = {
      sourceUrl: null,
      fileName: 'test2.tif',
      width: 5647,
      height: 3179,
      samplesPerPixel: 1,
      boundingBox,
      coordinateDisplayMode: metricTransform.coordinateDisplayMode,
      metricExtent: metricTransform.metricExtent,
      metricWidth: metricTransform.metricWidth,
      metricHeight: metricTransform.metricHeight,
      metricTransform,
      origin: [447934.5769, 4041619.7864, 0],
      resolution: [0.0147, -0.0147, 0],
      cellSize: { x: 0.0147, y: 0.0147, unit: 'm' },
      crsCode: 'EPSG:4549',
      crsName: 'EPSG:4549',
      isProjected: true,
    };
    const preview: RasterPreview = {
      width: 1600,
      height: 900,
      url: 'data:image/png;base64,preview',
    };
    const validityMask: RasterValidityMask = {
      width: 256,
      height: 144,
      boundingBox,
      data: new Uint8Array(256 * 144).fill(1),
    };

    loadRasterMetadataMock.mockImplementation(async () => metadataDeferred.promise);
    loadRasterPreviewMock.mockImplementation(async () => previewDeferred.promise);
    loadRasterValidityMaskMock.mockImplementation(async () => validityDeferred.promise);

    const file = new File(['fake'], 'test2.tif', { type: 'image/tiff' });

    act(() => {
      useRasterStore.getState().selectFile(file);
    });

    render(<Harness />);

    await waitFor(() => {
      expect(loadRasterMetadataMock).toHaveBeenCalledTimes(1);
      expect(useRasterStore.getState().status).toBe('loading');
    });

    act(() => {
      metadataDeferred.resolve(metadata);
    });

    await waitFor(() => {
      expect(useRasterStore.getState().metadata).toEqual(metadata);
      expect(loadRasterPreviewMock).toHaveBeenCalledTimes(1);
    });

    act(() => {
      previewDeferred.resolve(preview);
    });

    await waitFor(() => {
      expect(useRasterStore.getState().preview).toEqual(preview);
      expect(loadRasterValidityMaskMock).toHaveBeenCalledTimes(1);
    });

    act(() => {
      validityDeferred.resolve(validityMask);
    });

    await waitFor(() => {
      expect(useRasterStore.getState().validityMask).toEqual(validityMask);
      expect(useRasterStore.getState().validityStatus).toBe('ready');
    });
  });
});
