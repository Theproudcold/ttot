import { describe, expect, it } from 'vitest';

import {
  buildMapViewDebugPayload,
  summarizePreviewPayload,
} from '@/features/map/debugLogger';

describe('buildMapViewDebugPayload', () => {
  it('serializes core view diagnostics into a stable object', () => {
    expect(
      buildMapViewDebugPayload({
        getCenter: () => [447976.0823, 4041596.4207],
        getZoom: () => 19.25,
        getResolution: () => 0.018375,
        getProjection: () => ({
          getCode: () => 'EPSG:4549',
        }),
      }),
    ).toEqual({
      center: [447976.0823, 4041596.4207],
      zoom: 19.25,
      resolution: 0.018375,
      projection: 'EPSG:4549',
    });
  });

  it('returns placeholders when a view is missing', () => {
    expect(buildMapViewDebugPayload(null)).toEqual({
      center: null,
      zoom: null,
      resolution: null,
      projection: 'UNKNOWN',
    });
  });
});

describe('summarizePreviewPayload', () => {
  it('logs preview dimensions without dumping the whole data url', () => {
    expect(
      summarizePreviewPayload({
        width: 1600,
        height: 900,
        url: 'data:image/png;base64,abcdef',
      }),
    ).toEqual({
      width: 1600,
      height: 900,
      urlLength: 28,
    });
  });
});
