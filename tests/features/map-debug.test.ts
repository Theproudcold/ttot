import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildMapViewDebugPayload,
  debugLog,
  markPerformanceEnd,
  markPerformanceStart,
  measurePerformance,
  measurePerformanceAsync,
  summarizePreviewPayload,
} from '@/features/map/debugLogger';

describe('debugLog', () => {
  const originalDebugEnv = import.meta.env.VITE_DEBUG_GEO;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalDebugEnv === undefined) {
      vi.unstubAllEnvs();
      return;
    }

    vi.stubEnv('VITE_DEBUG_GEO', originalDebugEnv);
  });

  it('does not emit debug output when VITE_DEBUG_GEO is not enabled', () => {
    vi.stubEnv('VITE_DEBUG_GEO', '');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const groupSpy = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    const endSpy = vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);

    debugLog('loader', 'should stay quiet', { sourceId: 1 });

    expect(infoSpy).not.toHaveBeenCalled();
    expect(groupSpy).not.toHaveBeenCalled();
    expect(endSpy).not.toHaveBeenCalled();
  });

  it('emits grouped debug output when VITE_DEBUG_GEO is enabled', () => {
    vi.stubEnv('VITE_DEBUG_GEO', 'true');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const groupSpy = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    const endSpy = vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);

    debugLog('loader', 'starts logging', { sourceId: 1 });

    expect(groupSpy).toHaveBeenCalledWith('[GeoTIFFDebug][loader] starts logging');
    expect(infoSpy).toHaveBeenCalledWith({ sourceId: 1 });
    expect(endSpy).toHaveBeenCalledTimes(1);
  });
});

describe('performance helpers', () => {
  beforeEach(() => {
    performance.clearMarks();
    performance.clearMeasures();
  });

  afterEach(() => {
    performance.clearMarks();
    performance.clearMeasures();
  });

  it('creates a performance measure from paired marks', () => {
    markPerformanceStart('raster:metadata');
    markPerformanceEnd('raster:metadata');

    const measures = performance.getEntriesByName('raster:metadata', 'measure');
    expect(measures).toHaveLength(1);
    expect(measures[0].duration).toBeGreaterThanOrEqual(0);
  });

  it('wraps sync work in a performance measure', () => {
    const result = measurePerformance('grid:preview-geometry', () => 'preview-ready');

    expect(result).toBe('preview-ready');
    expect(performance.getEntriesByName('grid:preview-geometry', 'measure')).toHaveLength(1);
  });

  it('wraps async work in a performance measure even when it rejects', async () => {
    await expect(
      measurePerformanceAsync('raster:fence-window', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(performance.getEntriesByName('raster:fence-window', 'measure')).toHaveLength(1);
  });
});

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
