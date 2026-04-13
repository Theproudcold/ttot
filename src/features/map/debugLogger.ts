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

export function debugLog(scope: string, message: string, payload?: unknown) {
  const prefix = `[GeoTIFFDebug][${scope}] ${message}`;
  if (payload === undefined) {
    console.info(prefix);
    return;
  }

  console.groupCollapsed(prefix);
  console.info(payload);
  console.groupEnd();
}
