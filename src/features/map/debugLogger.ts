import type { RasterPreview } from '@/shared/types/raster';

type DebugProjectionLike = {
  getCode?: () => string;
} | null;

type DebugViewLike = {
  getCenter?: () => number[] | null | undefined;
  getZoom?: () => number | undefined;
  getResolution?: () => number | undefined;
  getProjection?: () => DebugProjectionLike;
} | null;

export function buildMapViewDebugPayload(view: DebugViewLike) {
  return {
    center: view?.getCenter?.() ?? null,
    zoom: view?.getZoom?.() ?? null,
    resolution: view?.getResolution?.() ?? null,
    projection: view?.getProjection?.()?.getCode?.() ?? 'UNKNOWN',
  };
}

export function summarizePreviewPayload(preview: RasterPreview | null) {
  if (!preview) {
    return null;
  }

  return {
    width: preview.width,
    height: preview.height,
    urlLength: preview.url.length,
  };
}

function isGeoDebugEnabled(): boolean {
  return import.meta.env.DEV && import.meta.env.VITE_DEBUG_GEO === 'true';
}

export function debugLog(scope: string, message: string, payload?: unknown) {
  if (!isGeoDebugEnabled()) {
    return;
  }

  const prefix = `[GeoTIFFDebug][${scope}] ${message}`;
  if (payload === undefined) {
    console.info(prefix);
    return;
  }

  console.groupCollapsed(prefix);
  console.info(payload);
  console.groupEnd();
}

export function markPerformanceStart(name: string) {
  if (typeof performance === 'undefined') {
    return;
  }

  performance.mark(`${name}:start`);
}

export function markPerformanceEnd(name: string) {
  if (typeof performance === 'undefined') {
    return;
  }

  performance.mark(`${name}:end`);
  performance.measure(name, `${name}:start`, `${name}:end`);
}

export function measurePerformance<T>(name: string, operation: () => T): T {
  markPerformanceStart(name);

  try {
    return operation();
  } finally {
    markPerformanceEnd(name);
  }
}

export async function measurePerformanceAsync<T>(name: string, operation: () => Promise<T>): Promise<T> {
  markPerformanceStart(name);

  try {
    return await operation();
  } finally {
    markPerformanceEnd(name);
  }
}
