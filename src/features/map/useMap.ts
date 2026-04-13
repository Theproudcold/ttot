import { useEffect, useRef } from 'react';

import Feature from 'ol/Feature.js';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import Draw from 'ol/interaction/Draw.js';
import Modify from 'ol/interaction/Modify.js';
import ImageLayer from 'ol/layer/Image.js';
import VectorLayer from 'ol/layer/Vector.js';
import Polygon from 'ol/geom/Polygon.js';
import Static from 'ol/source/ImageStatic.js';
import VectorSource from 'ol/source/Vector.js';
import { Fill, Stroke, Style } from 'ol/style.js';

import { useFenceStore } from '@/features/fence/fenceStore';
import { useGridStore } from '@/features/grid/gridStore';
import { buildMapViewDebugPayload, debugLog, summarizePreviewPayload } from '@/features/map/debugLogger';
import { useMapUiStore } from '@/features/map/mapUiStore';
import { ensureProjectionRegistered } from '@/shared/geo/crs';
import { getFenceSummary, isCoordinateInValidityMask, isFenceInsideValidityMask, isPointInFence } from '@/shared/geo/fence';
import { buildGridPreview } from '@/shared/geo/grid';
import {
  buildClassificationBreaks,
  buildClassifiedPreviewRgba,
  createPreviewDataUrl,
  findClassificationBreakForValue,
} from '@/shared/geo/raster';
import type { RasterMetadata } from '@/shared/types/raster';
import type { FenceRings } from '@/shared/types/fence';
import type { GridCell } from '@/shared/types/grid';

import { useRasterStore } from './rasterStore';

type DeferredMapResizeTarget = {
  getTarget: () => unknown;
  updateSize: () => void;
  renderSync: () => void;
};

function isBboxInside(
  innerBbox: [number, number, number, number],
  outerBbox: [number, number, number, number],
): boolean {
  return (
    innerBbox[0] >= outerBbox[0] &&
    innerBbox[1] >= outerBbox[1] &&
    innerBbox[2] <= outerBbox[2] &&
    innerBbox[3] <= outerBbox[3]
  );
}

function clampIndex(value: number, max: number): number {
  return Math.min(Math.max(0, value), max);
}

function getPixelPosition(
  coordinate: [number, number],
  metadata: RasterMetadata,
): { row: number; col: number } {
  const [minX, minY, maxX, maxY] = metadata.boundingBox;
  const col = clampIndex(
    Math.floor(((coordinate[0] - minX) / (maxX - minX || Number.EPSILON)) * metadata.width),
    metadata.width - 1,
  );
  const row = clampIndex(
    Math.floor(((maxY - coordinate[1]) / (maxY - minY || Number.EPSILON)) * metadata.height),
    metadata.height - 1,
  );

  return { row, col };
}

function getPreviewSampleValues(
  coordinate: [number, number],
  metadata: RasterMetadata,
  preview: NonNullable<ReturnType<typeof useRasterStore.getState>['preview']>,
): number[] | null {
  if (!preview.sampleData || !preview.sampleBandCount) {
    return null;
  }

  const [minX, minY, maxX, maxY] = metadata.boundingBox;
  const col = clampIndex(
    Math.floor(((coordinate[0] - minX) / (maxX - minX || Number.EPSILON)) * preview.width),
    preview.width - 1,
  );
  const row = clampIndex(
    Math.floor(((maxY - coordinate[1]) / (maxY - minY || Number.EPSILON)) * preview.height),
    preview.height - 1,
  );
  const offset = (row * preview.width + col) * preview.sampleBandCount;
  const values = [];

  for (let bandIndex = 0; bandIndex < preview.sampleBandCount; bandIndex += 1) {
    values.push(preview.sampleData[offset + bandIndex] ?? Number.NaN);
  }

  return values.every((value) => Number.isNaN(value)) ? null : values;
}

function findGridCellAtCoordinate(coordinate: [number, number], cells: GridCell[]): string | null {
  for (const cell of cells) {
    if (isPointInFence(coordinate, cell.polygon)) {
      return cell.id;
    }
  }

  return null;
}

function getPrimarySampleValue(sampleValues: number[] | null, noDataValue?: number | null): number | null {
  const primaryValue = sampleValues?.[0];
  if (primaryValue === undefined || !Number.isFinite(primaryValue)) {
    return null;
  }

  if (noDataValue !== null && noDataValue !== undefined && primaryValue === noDataValue) {
    return null;
  }

  return primaryValue;
}

export function useMap(metadata: RasterMetadata | null) {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const metadataRef = useRef<RasterMetadata | null>(metadata);
  const rasterLayerRef = useRef<ImageLayer<Static> | null>(null);
  const fenceSourceRef = useRef<VectorSource | null>(null);
  const fenceLayerRef = useRef<VectorLayer | null>(null);
  const gridSourceRef = useRef<VectorSource | null>(null);
  const gridLayerRef = useRef<VectorLayer | null>(null);
  const drawRef = useRef<Draw | null>(null);
  const modifyRef = useRef<Modify | null>(null);
  const setPointerText = useRasterStore((state) => state.setPointerText);
  const preview = useRasterStore((state) => state.preview);
  const validityMask = useRasterStore((state) => state.validityMask);
  const layers = useMapUiStore((state) => state.layers);
  const rasterRenderSettings = useMapUiStore((state) => state.rasterRenderSettings);
  const setHoverInfo = useMapUiStore((state) => state.setHoverInfo);
  const fence = useFenceStore((state) => state.fence);
  const fenceMode = useFenceStore((state) => state.mode);
  const setFence = useFenceStore((state) => state.setFence);
  const setValidationMessage = useFenceStore((state) => state.setValidationMessage);
  const cellSize = useGridStore((state) => state.cellSize);
  const gridCells = useGridStore((state) => state.cells);
  const setPreview = useGridStore((state) => state.setPreview);

  const previewRef = useRef(preview);
  const validityMaskRef = useRef(validityMask);
  const fenceRef = useRef(fence);
  const gridCellsRef = useRef(gridCells);
  const rasterRenderSettingsRef = useRef(rasterRenderSettings);

  useEffect(() => {
    metadataRef.current = metadata;
  }, [metadata]);

  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);

  useEffect(() => {
    validityMaskRef.current = validityMask;
  }, [validityMask]);

  useEffect(() => {
    fenceRef.current = fence;
  }, [fence]);

  useEffect(() => {
    gridCellsRef.current = gridCells;
  }, [gridCells]);

  useEffect(() => {
    rasterRenderSettingsRef.current = rasterRenderSettings;
  }, [rasterRenderSettings]);

  function scheduleMapResize(map: Map, callback?: () => void) {
    scheduleMapResizeFrame(map, callback);
  }

  function fitToRaster() {
    if (!mapRef.current || !metadata) {
      return;
    }

    mapRef.current.getView().fit(metadata.boundingBox, {
      padding: [24, 24, 24, 24],
      maxZoom: 22,
    });
    debugLog('map', '执行适配影像', {
      boundingBox: metadata.boundingBox,
      view: buildMapViewDebugPayload(mapRef.current.getView()),
      size: mapRef.current.getSize(),
    });
  }

  function fitToFence() {
    if (!mapRef.current || !fence) {
      return;
    }

    mapRef.current.getView().fit(fence.summary.bbox, {
      padding: [24, 24, 24, 24],
      maxZoom: 22,
    });
    debugLog('map', '执行适配围栏', {
      fenceBbox: fence.summary.bbox,
      view: buildMapViewDebugPayload(mapRef.current.getView()),
      size: mapRef.current.getSize(),
    });
  }

  function removeInteractions() {
    if (!mapRef.current) {
      return;
    }

    if (drawRef.current) {
      mapRef.current.removeInteraction(drawRef.current);
      drawRef.current = null;
    }

    if (modifyRef.current) {
      mapRef.current.removeInteraction(modifyRef.current);
      modifyRef.current = null;
    }
  }

  useEffect(() => {
    if (import.meta.env.VITEST || !mapElementRef.current || mapRef.current) {
      return;
    }

    const map = new Map({
      target: mapElementRef.current,
      view: new View({
        center: [0, 0],
        zoom: 2,
      }),
    });
    debugLog('map', '地图实例已创建', {
      targetSize: [
        mapElementRef.current.clientWidth,
        mapElementRef.current.clientHeight,
      ],
      view: buildMapViewDebugPayload(map.getView()),
    });

    const fenceSource = new VectorSource();
    const gridSource = new VectorSource();
    const fenceLayer = new VectorLayer({
      source: fenceSource,
      visible: layers.fence,
      style: new Style({
        stroke: new Stroke({
          color: '#111111',
          width: 2,
        }),
        fill: new Fill({
          color: 'rgba(17, 17, 17, 0.06)',
        }),
      }),
    });
    const gridLayer = new VectorLayer({
      source: gridSource,
      visible: layers.grid,
      style: new Style({
        stroke: new Stroke({
          color: 'rgba(0, 0, 0, 0.18)',
          width: 1,
        }),
        fill: new Fill({
          color: 'rgba(0, 0, 0, 0.01)',
        }),
      }),
    });
    map.addLayer(gridLayer);
    map.addLayer(fenceLayer);

    map.on('pointermove', (event) => {
      const [x, y] = event.coordinate;
      setPointerText(`${x.toFixed(3)}, ${y.toFixed(3)}`);

      const currentMetadata = metadataRef.current;
      const currentPreview = previewRef.current;
      const currentValidityMask = validityMaskRef.current;
      const currentFence = fenceRef.current;
      const currentGridCells = gridCellsRef.current;

      if (!currentMetadata || !currentPreview) {
        setHoverInfo(null);
        return;
      }

      const coordinate: [number, number] = [x, y];
      const sampleValues = getPreviewSampleValues(coordinate, currentMetadata, currentPreview);
      const primarySampleValue = getPrimarySampleValue(sampleValues, currentPreview.noDataValue);
      const classificationBreak =
        currentPreview.sampleBandCount === 1
          ? findClassificationBreakForValue(
              primarySampleValue ?? Number.NaN,
              buildClassificationBreaks(
                currentPreview.sampleRanges?.[0] ?? null,
                rasterRenderSettingsRef.current,
              ),
            )
          : null;

      setHoverInfo({
        coordinate,
        pixel: getPixelPosition(coordinate, currentMetadata),
        sampleValues,
        classificationLabel: classificationBreak?.label ?? null,
        classificationColor: classificationBreak?.color ?? null,
        inValidityMask: currentValidityMask
          ? isCoordinateInValidityMask(coordinate, currentValidityMask)
          : null,
        inFence: currentFence ? isPointInFence(coordinate, currentFence.geometry.coordinates) : false,
        gridCellId: findGridCellAtCoordinate(coordinate, currentGridCells),
      });
    });

    map.on('moveend', () => {
      debugLog('map', '地图 moveend', {
        size: map.getSize(),
        view: buildMapViewDebugPayload(map.getView()),
      });
    });

    map.on('rendercomplete', () => {
      debugLog('map', '地图 rendercomplete', {
        size: map.getSize(),
        view: buildMapViewDebugPayload(map.getView()),
      });
    });

    mapRef.current = map;
    fenceSourceRef.current = fenceSource;
    fenceLayerRef.current = fenceLayer;
    gridSourceRef.current = gridSource;
    gridLayerRef.current = gridLayer;
    scheduleMapResize(map);

    return () => {
      removeInteractions();
      map.setTarget(undefined);
      mapRef.current = null;
      fenceSourceRef.current = null;
      fenceLayerRef.current = null;
      gridSourceRef.current = null;
      gridLayerRef.current = null;
    };
  }, [setHoverInfo, setPointerText]);

  useEffect(() => {
    if (import.meta.env.VITEST || !mapRef.current) {
      return;
    }

    const map = mapRef.current;
    if (!metadata || !preview) {
      if (rasterLayerRef.current) {
        map.removeLayer(rasterLayerRef.current);
        rasterLayerRef.current = null;
        debugLog('map', '移除静态影像图层');
      }
      return;
    }

    ensureProjectionRegistered(metadata.crsCode);
    debugLog('map', '准备挂载静态影像预览', {
      metadata,
      preview: summarizePreviewPayload(preview),
      mapSize: map.getSize(),
      currentView: buildMapViewDebugPayload(map.getView()),
    });

    const styledPreviewUrl =
      preview.sampleBandCount === 1 && preview.sampleData
        ? createPreviewDataUrl(
            preview.width,
            preview.height,
            buildClassifiedPreviewRgba(
              preview.sampleData,
              preview.width,
              preview.height,
              buildClassificationBreaks(preview.sampleRanges?.[0] ?? null, rasterRenderSettings),
              preview.noDataValue ?? null,
            ),
          )
        : preview.url;

    const source = new Static({
      url: styledPreviewUrl,
      imageExtent: metadata.boundingBox,
      projection: metadata.crsCode,
      crossOrigin: 'anonymous',
    });

    const layer = new ImageLayer({
      source,
      visible: layers.raster,
    });

    if (rasterLayerRef.current) {
      map.removeLayer(rasterLayerRef.current);
    }

    rasterLayerRef.current = layer;
    map.getLayers().insertAt(0, layer);
    const nextView = new View({
      projection: metadata.crsCode,
      center: [
        (metadata.boundingBox[0] + metadata.boundingBox[2]) / 2,
        (metadata.boundingBox[1] + metadata.boundingBox[3]) / 2,
      ],
      zoom: 2,
    });
    map.setView(nextView);
    debugLog('map', '静态影像图层已插入', {
      layerCount: map.getLayers().getLength(),
      view: buildMapViewDebugPayload(nextView),
      imageExtent: metadata.boundingBox,
    });
    scheduleMapResize(map, () => {
      nextView.fit(metadata.boundingBox, {
        padding: [24, 24, 24, 24],
        maxZoom: 22,
      });
      debugLog('map', '静态影像挂载后的首轮 fit 已执行', {
        size: map.getSize(),
        view: buildMapViewDebugPayload(nextView),
      });
    });

    const handleImageLoadStart = () => {
      debugLog('map', 'ImageStatic imageloadstart', {
        imageExtent: source.getImageExtent(),
        urlLength: styledPreviewUrl.length,
      });
    };
    const handleImageLoadEnd = () => {
      debugLog('map', 'ImageStatic imageloadend', {
        imageExtent: source.getImageExtent(),
        mapSize: map.getSize(),
        view: buildMapViewDebugPayload(nextView),
      });
      scheduleMapResize(map, () => {
        nextView.fit(metadata.boundingBox, {
          padding: [24, 24, 24, 24],
          maxZoom: 22,
        });
        debugLog('map', 'imageloadend 后再次 fit', {
          size: map.getSize(),
          view: buildMapViewDebugPayload(nextView),
        });
      });
    };
    const handleImageLoadError = (event: unknown) => {
      debugLog('map', 'ImageStatic imageloaderror', event);
    };

    source.on('imageloadstart', handleImageLoadStart);
    source.on('imageloadend', handleImageLoadEnd);
    source.on('imageloaderror', handleImageLoadError);

    return () => {
      source.un('imageloadstart', handleImageLoadStart);
      source.un('imageloadend', handleImageLoadEnd);
      source.un('imageloaderror', handleImageLoadError);
    };
  }, [layers.raster, metadata, preview, rasterRenderSettings]);

  useEffect(() => {
    fenceLayerRef.current?.setVisible(layers.fence);
  }, [layers.fence]);

  useEffect(() => {
    gridLayerRef.current?.setVisible(layers.grid);
  }, [layers.grid]);

  useEffect(() => {
    if (import.meta.env.VITEST || !fenceSourceRef.current) {
      return;
    }

    const source = fenceSourceRef.current;
    source.clear();

    if (!fence) {
      return;
    }

    const feature = new Feature({
      geometry: new Polygon(fence.geometry.coordinates),
    });
    source.addFeature(feature);
  }, [fence]);

  useEffect(() => {
    if (import.meta.env.VITEST || !gridSourceRef.current) {
      return;
    }

    const source = gridSourceRef.current;
    source.clear();

    if (!fence) {
      setPreview([], null);
      return;
    }

    try {
      const preview = buildGridPreview(fence.geometry.coordinates, cellSize);
      setPreview(preview.cells, preview.summary);

      for (const cell of preview.cells) {
        source.addFeature(
          new Feature({
            geometry: new Polygon(cell.polygon),
          }),
        );
      }
    } catch {
      setPreview([], null);
    }
  }, [cellSize, fence, setPreview]);

  useEffect(() => {
    if (import.meta.env.VITEST || !mapRef.current || !fenceSourceRef.current) {
      return;
    }

    removeInteractions();

    const map = mapRef.current;
    const source = fenceSourceRef.current;

    const validateFence = (rings: FenceRings): string | null => {
      if (!metadata) {
        return '请先完成 GeoTIFF 读取。';
      }

      const summary = getFenceSummary(rings);
      if (!isBboxInside(summary.bbox, metadata.boundingBox)) {
        return '围栏必须落在影像范围内。';
      }

      if (validityMask && !isFenceInsideValidityMask(rings, validityMask)) {
        return '围栏必须落在影像有效数据范围内';
      }

      return null;
    };

    if (fenceMode === 'draw') {
      const draw = new Draw({
        source,
        type: 'Polygon',
      });

      draw.on('drawstart', () => {
        source.clear();
      });

      draw.on('drawend', (event) => {
        const geometry = event.feature.getGeometry();
        if (!geometry || !(geometry instanceof Polygon)) {
          return;
        }

        const rings = geometry.getCoordinates() as FenceRings;
        const validationError = validateFence(rings);
        if (validationError) {
          source.clear();
          setValidationMessage(validationError);
          return;
        }

        setFence(rings);
      });

      map.addInteraction(draw);
      drawRef.current = draw;
      return;
    }

    if (fenceMode === 'edit' && source.getFeatures().length > 0) {
      const modify = new Modify({ source });
      modify.on('modifyend', (event) => {
        const geometry = event.features.item(0)?.getGeometry();
        if (!geometry || !(geometry instanceof Polygon)) {
          return;
        }

        const rings = geometry.getCoordinates() as FenceRings;
        const validationError = validateFence(rings);
        if (validationError) {
          source.clear();
          if (fence) {
            source.addFeature(
              new Feature({
                geometry: new Polygon(fence.geometry.coordinates),
              }),
            );
          }
          setValidationMessage(validationError);
          return;
        }

        setFence(rings);
      });

      map.addInteraction(modify);
      modifyRef.current = modify;
    }
  }, [fence, fenceMode, metadata, setFence, setValidationMessage, validityMask]);

  return {
    mapElementRef,
    fitToRaster,
    fitToFence,
  };
}

export function scheduleMapResizeFrame(
  map: DeferredMapResizeTarget,
  callback?: () => void,
  scheduler: typeof requestAnimationFrame = requestAnimationFrame,
) {
  scheduler(() => {
    if (!map.getTarget()) {
      debugLog('map', '跳过延迟刷新：地图 target 已丢失');
      return;
    }

    map.updateSize();
    callback?.();

    try {
      map.renderSync();
    } catch {
      // OpenLayers may briefly tear down its internal renderer while the target/view is switching.
      debugLog('map', 'renderSync 期间触发保护性降级');
    }
  });
}
