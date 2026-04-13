import { act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useRasterStore } from '@/features/map/rasterStore';
import type { RasterPreview } from '@/shared/types/raster';
import type { RasterValidityMask } from '@/shared/types/raster';

describe('useRasterStore', () => {
  afterEach(() => {
    act(() => {
      useRasterStore.getState().reset();
    });
  });

  it('selects a file and clears previous metadata', () => {
    const file = new File(['fake'], 'demo.tif', { type: 'image/tiff' });
    const validityMask: RasterValidityMask = {
      width: 2,
      height: 2,
      boundingBox: [0, 0, 1, 1],
      data: new Uint8Array([1, 1, 1, 1]),
    };
    const preview: RasterPreview = {
      url: 'data:image/png;base64,preview',
      width: 320,
      height: 180,
    };

    act(() => {
      useRasterStore.getState().setMetadata({
        sourceUrl: '/old.tif',
        fileName: 'old.tif',
        width: 100,
        height: 100,
        samplesPerPixel: 1,
        boundingBox: [0, 0, 1, 1],
        origin: [0, 1, 0],
        resolution: [1, -1, 0],
        cellSize: { x: 1, y: 1, unit: 'm' },
        crsCode: 'EPSG:3857',
        crsName: 'EPSG:3857',
        isProjected: true,
      });
      useRasterStore.getState().setPreview(preview);
      useRasterStore.getState().setValidityMask(validityMask);
      useRasterStore.getState().selectFile(file);
    });

    expect(useRasterStore.getState().metadata).toBeNull();
    expect(useRasterStore.getState().preview).toBeNull();
    expect(useRasterStore.getState().previewStatus).toBe('idle');
    expect(useRasterStore.getState().validityMask).toBeNull();
    expect(useRasterStore.getState().validityStatus).toBe('idle');
    expect(useRasterStore.getState().sourceFile?.name).toBe('demo.tif');
    expect(useRasterStore.getState().sourceLabel).toBe('demo.tif');
  });
});
