import { useEffect, useRef } from 'react';

import Feature from 'ol/Feature.js';
import { useDebounce } from '@/shared/hooks/useDebounce';
import Map from 'ol/Map.js';
import type MapBrowserEvent from 'ol/MapBrowserEvent.js';
import View from 'ol/View.js';
import Draw from 'ol/interaction/Draw.js';
import Modify from 'ol/interaction/Modify.js';
import ImageLayer from 'ol/layer/Image.js';
import Layer from 'ol/layer/Layer.js';
import VectorLayer from 'ol/layer/Vector.js';
import WebGLVectorLayer from 'ol/layer/WebGLVector.js';
import MultiPoint from 'ol/geom/MultiPoint.js';
import Polygon from 'ol/geom/Polygon.js';
import Static from 'ol/source/ImageStatic.js';
import VectorSource from 'ol/source/Vector.js';
import { Circle as CircleStyle, Fill, Stroke, Style } from 'ol/style.js';
import { altKeyOnly } from 'ol/events/condition.js';

import { useFenceStore } from '@/features/fence/fenceStore';
import { useGridStore } from '@/features/grid/gridStore';
import { useLoadingStore } from '@/features/loading/loadingStore';
import { useMapUiStore } from '@/features/map/mapUiStore';
import {
  buildMapViewDebugPayload,
  debugLog,
  measurePerformance,
  measurePerformanceAsync,
  summarizePreviewPayload,
} from '@/features/map/debugLogger';
import { ensureProjectionRegistered } from '@/shared/geo/crs';
import { clipFenceToBoundingBox, clipFenceToValidityMask, getFenceSummary, isCoordinateInValidityMask, isFenceInsideValidityMask, isPointInFence } from '@/shared/geo/fence';
import { buildGridAggregationFromFenceWindowAsync } from '@/shared/geo/geotiffExport';
import { readFenceWindowWithCache } from '@/shared/geo/fenceWindow';
import { buildGridPreview } from '@/shared/geo/grid';
import { buildAggregateGridPayload } from '@/shared/workers/rasterWorkerRequests';
import { registerRasterWorker, unregisterRasterWorker } from '@/shared/workers/rasterWorkerRegistry';
import {
  buildRasterClassificationPreviewRgba,
  buildRasterSourceKey,
  createPreviewDataUrl,
  findRasterClassificationMatch,
} from '@/shared/geo/raster';
import type { RasterMetadata, RasterWorkerRequest, RasterWorkerResponse } from '@/shared/types/raster';
import type { FenceRings } from '@/shared/types/fence';
import type { GridCell, GridRenderSettings } from '@/shared/types/grid';

import { useRasterStore } from './rasterStore';
import { buildGridLookup, findCellAtCoordinate } from '@/shared/geo/gridLookup';
import type { GridLookup } from '@/shared/geo/gridLookup';

import {
  type DeferredMapResizeTarget,
  canClassifySingleBand,
  createAnimationFrameValueScheduler,
  getGridCellStyleColors,
  getPixelPosition,
  getPreviewSampleValues,
  getPrimarySampleValue,
  getVisibleClassificationLayer,
  isBboxInside,
} from './mapUtils';

/** 网格图层的渲染要素上限：超过则按步长降采样渲染（导出与悬停仍覆盖全部网格） */
const GRID_RENDER_CELL_BUDGET = 50_000;

/**
 * 网格要素上的样式属性名：WebGL 层用表达式读取，普通矢量层读同一批属性。
 */
const GRID_STYLE_PROPERTIES = {
  fill: 'fillColor',
  stroke: 'strokeColor',
  strokeWidth: 'strokeWidth',
} as const;

let webglVectorSupport: boolean | null = null;

/**
 * 网格图层优先用 WebGL 渲染：5 万级多边形在 Canvas 矢量渲染下每次平移/缩放都要重放全部要素
 * （实测 54600 格时主线程 89 次输入事件消耗约 1.7 s），WebGL 把这件事交给 GPU。
 * 取不到 WebGL2 时回退普通矢量层，样式来源完全一致。
 */
function supportsWebglVectorLayer(): boolean {
  if (webglVectorSupport !== null) {
    return webglVectorSupport;
  }

  try {
    webglVectorSupport = Boolean(document.createElement('canvas').getContext('webgl2'));
  } catch {
    webglVectorSupport = false;
  }

  return webglVectorSupport;
}

/**
 * 把当前配色写到要素属性上。
 * 样式不再挂在每个要素的 Style 对象上，WebGL 与矢量两种实现因此可以共用同一份要素数据。
 */
function applyGridFeatureStyle(
  feature: Feature,
  cell: GridCell,
  classificationLayer: Parameters<typeof getGridCellStyleColors>[1],
  settings: GridRenderSettings,
): void {
  const colors = getGridCellStyleColors(cell, classificationLayer, settings);

  feature.set(GRID_STYLE_PROPERTIES.fill, colors.fillColor);
  feature.set(GRID_STYLE_PROPERTIES.stroke, colors.strokeColor);
  feature.set(GRID_STYLE_PROPERTIES.strokeWidth, settings.strokeWidth);
}

/**
 * useMap 是地图核心 Hook，负责：
 * 1. 创建并管理 OpenLayers Map 实例；
 * 2. 响应影像、围栏、网格、分类图层等状态变化，动态更新图层；
 * 3. 处理鼠标悬停（pointermove）交互，更新 hoverInfo；
 * 4. 提供围栏绘制（Draw）与编辑（Modify）交互逻辑。
 */
export function useMap(metadata: RasterMetadata | null) {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const metadataRef = useRef<RasterMetadata | null>(metadata);
  const rasterLayerRef = useRef<ImageLayer<Static> | null>(null);
  const fenceSourceRef = useRef<VectorSource | null>(null);
  const fenceLayerRef = useRef<VectorLayer | null>(null);
  const gridSourceRef = useRef<VectorSource | null>(null);
  const gridLayerRef = useRef<Layer | null>(null);
  const drawRef = useRef<Draw | null>(null);
  const modifyRef = useRef<Modify | null>(null);
  const setPointerText = useRasterStore((state) => state.setPointerText);
  const preview = useRasterStore((state) => state.preview);
  const validityMask = useRasterStore((state) => state.validityMask);
  const sourceFile = useRasterStore((state) => state.sourceFile);
  const layers = useMapUiStore((state) => state.layers);
  const classificationLayers = useMapUiStore((state) => state.classificationLayers);
  const visibleClassificationLayerId = useMapUiStore((state) => state.visibleClassificationLayerId);
  const setHoverInfo = useMapUiStore((state) => state.setHoverInfo);
  const fence = useFenceStore((state) => state.fence);
  const fenceMode = useFenceStore((state) => state.mode);
  const setFence = useFenceStore((state) => state.setFence);
  const updateFence = useFenceStore((state) => state.updateFence);
  const stopInteraction = useFenceStore((state) => state.stopInteraction);
  const setValidationMessage = useFenceStore((state) => state.setValidationMessage);
  const cellSize = useGridStore((state) => state.cellSize);
  const rotation = useGridStore((state) => state.rotation);
  const aggregationMode = useGridStore((state) => state.aggregationMode);
  const gridCells = useGridStore((state) => state.cells);
  const setPreview = useGridStore((state) => state.setPreview);
  const gridRenderSettings = useMapUiStore((state) => state.gridRenderSettings);

  const previewRef = useRef(preview);
  const validityMaskRef = useRef(validityMask);
  const fenceRef = useRef(fence);
  const gridLookupRef = useRef<GridLookup | null>(null);
  const gridRenderSettingsRef = useRef(gridRenderSettings);
  const visibleClassificationLayerRef = useRef(
    getVisibleClassificationLayer(classificationLayers, visibleClassificationLayerId),
  );
  const gridStyleCacheRef = useRef<globalThis.Map<string, Style>>(new globalThis.Map());
  const workerRef = useRef<Worker | null>(null);
  const previewJobIdRef = useRef(0);
  const aggregationJobIdRef = useRef(0);

  const debouncedCellSize = useDebounce(cellSize, 200);
  const debouncedRotation = useDebounce(rotation, 200);

  useEffect(() => {
    if (import.meta.env.VITEST) {
      return;
    }

    const worker = new Worker(
      new URL('../../shared/workers/rasterCompute.worker.ts', import.meta.url),
      { type: 'module' },
    );
    worker.onerror = (error) => {
      debugLog('map', 'Worker 全局错误', error);
    };
    workerRef.current = worker;
    registerRasterWorker('map', worker);

    return () => {
      unregisterRasterWorker('map', worker);
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const unsubRaster = useRasterStore.subscribe((state) => {
      metadataRef.current = state.metadata;
      previewRef.current = state.preview;
      validityMaskRef.current = state.validityMask;
    });
    const unsubFence = useFenceStore.subscribe((state) => {
      fenceRef.current = state.fence;
    });
    const unsubMapUi = useMapUiStore.subscribe((state) => {
      visibleClassificationLayerRef.current = getVisibleClassificationLayer(
        state.classificationLayers,
        state.visibleClassificationLayerId,
      );
      gridRenderSettingsRef.current = state.gridRenderSettings;
    });

    metadataRef.current = useRasterStore.getState().metadata;
    previewRef.current = useRasterStore.getState().preview;
    validityMaskRef.current = useRasterStore.getState().validityMask;
    fenceRef.current = useFenceStore.getState().fence;
    visibleClassificationLayerRef.current = getVisibleClassificationLayer(
      useMapUiStore.getState().classificationLayers,
      useMapUiStore.getState().visibleClassificationLayerId,
    );
    gridRenderSettingsRef.current = useMapUiStore.getState().gridRenderSettings;

    return () => {
      unsubRaster();
      unsubFence();
      unsubMapUi();
    };
  }, []);


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
      zIndex: 3,
      renderBuffer: 200,
      style: new Style({
        stroke: new Stroke({
          color: '#111111',
          width: 2,
          lineJoin: 'round',
          lineCap: 'round',
        }),
        fill: new Fill({
          color: 'rgba(17, 17, 17, 0.06)',
        }),
      }),
    });
    const gridLayer: Layer = supportsWebglVectorLayer()
      ? new WebGLVectorLayer({
          source: gridSource,
          visible: layers.grid,
          zIndex: 2,
          style: {
            'fill-color': ['get', GRID_STYLE_PROPERTIES.fill],
            'stroke-color': ['get', GRID_STYLE_PROPERTIES.stroke],
            'stroke-width': ['get', GRID_STYLE_PROPERTIES.strokeWidth],
          },
        })
      : new VectorLayer({
          source: gridSource,
          visible: layers.grid,
          zIndex: 2,
          // 缓存键改为「配色组合」：大量网格共用少数几种配色，
          // 命中率比按要素 id 缓存更高，也不再随网格数量增长
          style: (feature) => {
            const fillColor = feature.get(GRID_STYLE_PROPERTIES.fill) as string | undefined;
            const strokeColor = feature.get(GRID_STYLE_PROPERTIES.stroke) as string | undefined;
            const strokeWidth = feature.get(GRID_STYLE_PROPERTIES.strokeWidth) as number | undefined;

            if (!fillColor || !strokeColor) {
              return new Style({
                stroke: new Stroke({ color: 'rgba(0, 0, 0, 0)', width: 1 }),
                fill: new Fill({ color: 'rgba(0, 0, 0, 0)' }),
              });
            }

            const cacheKey = `${fillColor}|${strokeColor}|${strokeWidth ?? 1}`;
            const cached = gridStyleCacheRef.current.get(cacheKey);
            if (cached) return cached;

            const style = new Style({
              stroke: new Stroke({ color: strokeColor, width: strokeWidth ?? 1 }),
              fill: new Fill({ color: fillColor }),
            });
            gridStyleCacheRef.current.set(cacheKey, style);
            return style;
          },
        });
    map.addLayer(gridLayer);
    map.addLayer(fenceLayer);

    const pointerMoveScheduler = createAnimationFrameValueScheduler<[number, number]>((coordinate) => {
      const currentMetadata = metadataRef.current;
      const currentPreview = previewRef.current;
      const currentValidityMask = validityMaskRef.current;
      const currentFence = fenceRef.current;
      const [x, y] = coordinate;
      const isDegree = currentMetadata?.cellSize.unit === 'degree';
      const decimals = isDegree ? 6 : 3;
      setPointerText(`${x.toFixed(decimals)}, ${y.toFixed(decimals)}`);

      if (!currentMetadata || !currentPreview) {
        setHoverInfo(null);
        return;
      }

      const sampleValues = getPreviewSampleValues(coordinate, currentMetadata, currentPreview);
      const primarySampleValue = getPrimarySampleValue(sampleValues, currentPreview.noDataValue);
      const hitGridCell = findCellAtCoordinate(coordinate, gridLookupRef.current);
      const visibleClassificationLayer = visibleClassificationLayerRef.current;
      const classificationMatch =
        canClassifySingleBand(currentPreview) && visibleClassificationLayer
          ? findRasterClassificationMatch(
              primarySampleValue ?? Number.NaN,
              visibleClassificationLayer,
            )
          : null;

      setHoverInfo({
        coordinate,
        pixel: getPixelPosition(coordinate, currentMetadata),
        sampleValues,
        classificationLayerName: visibleClassificationLayer?.label ?? null,
        classificationLabel: classificationMatch?.label ?? null,
        classificationColor: classificationMatch?.color ?? null,
        inValidityMask: currentValidityMask
          ? isCoordinateInValidityMask(coordinate, currentValidityMask)
          : null,
        inFence: currentFence ? isPointInFence(coordinate, currentFence.geometry.coordinates) : false,
        gridCellId: hitGridCell?.id ?? null,
        gridMeanValue: hitGridCell?.aggregation?.outputValue ?? null,
        gridValidPixelCount: hitGridCell?.aggregation?.validPixelCount ?? null,
      });
    });
    const handlePointerMove = (event: MapBrowserEvent) => {
      pointerMoveScheduler.schedule([event.coordinate[0], event.coordinate[1]]);
    };

    map.on('pointermove', handlePointerMove);

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

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        stopInteraction();
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      pointerMoveScheduler.cancel();
      map.un('pointermove', handlePointerMove);
      removeInteractions();
      map.setTarget(undefined);
      mapRef.current = null;
      fenceSourceRef.current = null;
      fenceLayerRef.current = null;
      gridSourceRef.current = null;
      gridLayerRef.current = null;
    };
  }, [setHoverInfo, setPointerText, stopInteraction]);

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

    let source: Static | null = null;
    let nextView: View | null = null;
    let disposed = false;

    const handleImageLoadStart = () => {
      debugLog('map', 'ImageStatic imageloadstart', {
        imageExtent: source?.getImageExtent(),
        urlLength: source?.getUrl()?.length ?? 0,
      });
    };
    const handleImageLoadEnd = () => {
      if (!nextView) return;
      debugLog('map', 'ImageStatic imageloadend', {
        imageExtent: source?.getImageExtent(),
        mapSize: map.getSize(),
        view: buildMapViewDebugPayload(nextView),
      });
      scheduleMapResize(map, () => {
        nextView!.fit(metadata.boundingBox, {
          padding: [24, 24, 24, 24],
          maxZoom: 22,
        });
        debugLog('map', 'imageloadend 后再次 fit', {
          size: map.getSize(),
          view: buildMapViewDebugPayload(nextView!),
        });
      });
    };
    const handleImageLoadError = (event: unknown) => {
      debugLog('map', 'ImageStatic imageloaderror', event);
    };

    void (async () => {
      const visibleClassificationLayer = getVisibleClassificationLayer(
        classificationLayers,
        visibleClassificationLayerId,
      );
      const previewSampleData = preview.sampleData;
      let styledPreviewUrl = preview.url;

      const computeStyledPreviewUrlSync = () =>
        measurePerformance('raster:styled-preview', () =>
          createPreviewDataUrl(
            preview.width,
            preview.height,
            buildRasterClassificationPreviewRgba(
              previewSampleData!,
              preview.width,
              preview.height,
              visibleClassificationLayer!,
              preview.noDataValue ?? null,
            ),
          ),
        );

      if (
        canClassifySingleBand(preview) &&
        previewSampleData &&
        visibleClassificationLayer &&
        workerRef.current
      ) {
        previewJobIdRef.current += 1;
        const jobId = `${previewJobIdRef.current}`;

        try {
          styledPreviewUrl = await new Promise<string>((resolve, reject) => {
            const worker = workerRef.current!;
            const handleMessage = (event: MessageEvent<RasterWorkerResponse>) => {
              const response = event.data;
              if (response.id !== jobId) return;
              clearTimeout(timeout);
              worker.removeEventListener('message', handleMessage);
              worker.removeEventListener('error', handleError);
              if (response.type === 'recolor-preview') {
                const rgba = new Uint8ClampedArray(response.result.rgbaBuffer);
                resolve(
                  createPreviewDataUrl(
                    response.result.width,
                    response.result.height,
                    rgba,
                  ),
                );
              } else {
                resolve(preview.url);
              }
            };
            const handleError = (event: ErrorEvent) => {
              clearTimeout(timeout);
              worker.removeEventListener('message', handleMessage);
              worker.removeEventListener('error', handleError);
              reject(new Error(`Worker error: ${event.message}`));
            };
            worker.addEventListener('message', handleMessage);
            worker.addEventListener('error', handleError);
            const timeout = setTimeout(() => {
              worker.removeEventListener('message', handleMessage);
              worker.removeEventListener('error', handleError);
              reject(new Error('Worker preview timeout'));
            }, 30000);
            worker.postMessage({
              id: jobId,
              type: 'recolor-preview',
              payload: {
                width: preview.width,
                height: preview.height,
                sampleData: previewSampleData.slice(),
                noDataValue: preview.noDataValue ?? null,
                layer: visibleClassificationLayer,
              },
            } satisfies RasterWorkerRequest);
          });
        } catch (workerError) {
          debugLog('map', 'Worker 预览重着色失败，回退主线程', workerError);
          styledPreviewUrl = computeStyledPreviewUrlSync();
        }
      } else if (
        canClassifySingleBand(preview) &&
        previewSampleData &&
        visibleClassificationLayer
      ) {
        styledPreviewUrl = computeStyledPreviewUrlSync();
      }

      if (disposed) {
        return;
      }

      source = new Static({
        url: styledPreviewUrl,
        imageExtent: metadata.boundingBox,
        projection: metadata.crsCode,
        crossOrigin: 'anonymous',
      });

      const layer = new ImageLayer({
        source,
        visible: layers.raster,
        zIndex: 0,
      });

      if (rasterLayerRef.current) {
        map.removeLayer(rasterLayerRef.current);
      }

      rasterLayerRef.current = layer;
      map.getLayers().insertAt(0, layer);
      nextView = new View({
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
        nextView!.fit(metadata.boundingBox, {
          padding: [24, 24, 24, 24],
          maxZoom: 22,
        });
        debugLog('map', '静态影像挂载后的首轮 fit 已执行', {
          size: map.getSize(),
          view: buildMapViewDebugPayload(nextView),
        });
      });

      source.on('imageloadstart', handleImageLoadStart);
      source.on('imageloadend', handleImageLoadEnd);
      source.on('imageloaderror', handleImageLoadError);
    })();

    return () => {
      disposed = true;
      if (source) {
        source.un('imageloadstart', handleImageLoadStart);
        source.un('imageloadend', handleImageLoadEnd);
        source.un('imageloaderror', handleImageLoadError);
      }
    };
  }, [classificationLayers, layers.raster, metadata, preview, visibleClassificationLayerId]);

  useEffect(() => {
    fenceLayerRef.current?.setVisible(layers.fence);
  }, [layers.fence]);

  useEffect(() => {
    const layer = fenceLayerRef.current;
    if (!layer) return;

    if (fenceMode === 'edit') {
      layer.setStyle((feature) => {
        const geometry = feature.getGeometry();
        if (!geometry) return [];
        const coordinates = (geometry as Polygon).getCoordinates()[0] ?? [];
        return [
          new Style({
            stroke: new Stroke({
              color: '#111111',
              width: 2,
              lineJoin: 'round',
              lineCap: 'round',
            }),
            fill: new Fill({
              color: 'rgba(17, 17, 17, 0.06)',
            }),
          }),
          new Style({
            image: new CircleStyle({
              radius: 6,
              fill: new Fill({ color: '#3388ff' }),
              stroke: new Stroke({ color: '#ffffff', width: 2 }),
            }),
            geometry: new MultiPoint(coordinates),
          }),
        ];
      });
    } else {
      layer.setStyle(
        new Style({
          stroke: new Stroke({
            color: '#111111',
            width: 2,
            lineJoin: 'round',
            lineCap: 'round',
          }),
          fill: new Fill({
            color: 'rgba(17, 17, 17, 0.06)',
          }),
        }),
      );
    }
  }, [fenceMode]);

  useEffect(() => {
    gridLayerRef.current?.setVisible(layers.grid);
  }, [layers.grid]);

  useEffect(() => {
    gridStyleCacheRef.current.clear();

    // 配色变了要把属性刷到已有要素上：WebGL 层与矢量层都从这里取颜色
    const source = gridSourceRef.current;
    if (source) {
      for (const feature of source.getFeatures()) {
        const cell = feature.get('gridCell') as GridCell | undefined;
        if (cell) {
          applyGridFeatureStyle(
            feature,
            cell,
            visibleClassificationLayerRef.current,
            gridRenderSettingsRef.current,
          );
          feature.changed();
        }
      }

      source.changed();
    }

    gridLayerRef.current?.changed();
  }, [classificationLayers, gridCells, visibleClassificationLayerId, gridRenderSettings]);

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
    let disposed = false;

    const renderGridPreview = (
      cells: GridCell[],
      summary: ReturnType<typeof buildGridPreview>['summary'] | null,
      origin?: ReturnType<typeof buildGridPreview> | null,
      geometryChanged = false,
      /** 悬停查表用的单元集合；渲染降采样时传入全量，保证任意网格都能命中 */
      lookupCells: GridCell[] = cells,
    ) => {
      setPreview(cells, summary, origin ? {
        metricOrigin: origin.metricOrigin,
        metricCellSize: origin.metricCellSize,
        metricTransform: origin.metricTransform ?? null,
      } : null);

      gridLookupRef.current = origin
        ? buildGridLookup({ ...origin, cells: lookupCells }, origin.metricTransform ?? null)
        : null;

      const existingFeatures = source.getFeatures();
      const existingById = new globalThis.Map<string, Feature>();
      for (const feature of existingFeatures) {
        const cell = feature.get('gridCell') as GridCell | undefined;
        if (cell) {
          existingById.set(cell.id, feature);
        }
      }

      const nextIds = new globalThis.Set<string>();
      for (const cell of cells) {
        nextIds.add(cell.id);
        const existing = existingById.get(cell.id);
        if (existing) {
          existing.set('gridCell', cell);
          if (geometryChanged) {
            existing.setGeometry(new Polygon(cell.polygon));
          }
          applyGridFeatureStyle(
            existing,
            cell,
            visibleClassificationLayerRef.current,
            gridRenderSettingsRef.current,
          );
          existing.changed();
        } else {
          const feature = new Feature({
            geometry: new Polygon(cell.polygon),
            gridCell: cell,
          });
          applyGridFeatureStyle(
            feature,
            cell,
            visibleClassificationLayerRef.current,
            gridRenderSettingsRef.current,
          );
          source.addFeature(feature);
        }
      }

      for (const feature of existingFeatures) {
        const cell = feature.get('gridCell') as GridCell | undefined;
        if (!cell || !nextIds.has(cell.id)) {
          source.removeFeature(feature);
        }
      }
    };

    if (!fence) {
      renderGridPreview([], null);
      return () => {
        disposed = true;
      };
    }

    // 编辑围栏时暂不重新计算网格，避免拖拽顶点过程中频繁触发重算
    if (fenceMode === 'edit') {
      return () => {
        disposed = true;
      };
    }

    try {
      const metricTransform = metadata?.metricTransform;

      const basePreview = measurePerformance('grid:preview-geometry', () =>
        buildGridPreview(fence.geometry.coordinates, cellSize, {
          metricTransform,
          rotationDeg: rotation,
          maxPreviewCells: GRID_RENDER_CELL_BUDGET,
        }),
      );
      renderGridPreview(basePreview.cells, basePreview.summary, basePreview, true);

      if (!sourceFile) {
        return () => {
          disposed = true;
        };
      }

      void (async () => {
        try {
          useLoadingStore.getState().start('正在计算网格聚合...');
          const fenceRings = fence.geometry.coordinates;
          const sourceKey = buildRasterSourceKey(sourceFile);

          // Worker 不可用时的主线程路径：同样走带缓存的窗口读取
          const computeAggregationFallback = () =>
            measurePerformanceAsync('raster:fence-window', () =>
              readFenceWindowWithCache({ source: sourceFile, sourceKey, fenceRings, samples: [0] }),
            ).then((fenceWindow) =>
              measurePerformanceAsync('grid:aggregation', () =>
                buildGridAggregationFromFenceWindowAsync(
                  {
                    ...fenceWindow,
                    fenceRings,
                    metricTransform,
                    gridCellWidth: cellSize,
                    gridCellHeight: cellSize,
                    aggregationMode,
                    rotationDeg: rotation,
                  },
                  {
                    rowsPerChunk: 128,
                  },
                ),
              ),
            );

          let aggregation: import('@/shared/types/grid').GridAggregationResult;

          if (workerRef.current) {
            useLoadingStore.getState().update('正在汇总网格像元...');
            aggregationJobIdRef.current += 1;
            const jobId = `${aggregationJobIdRef.current}`;
            try {
              aggregation = await new Promise<import('@/shared/types/grid').GridAggregationResult>((resolve, reject) => {
                const worker = workerRef.current!;
                const handleMessage = (event: MessageEvent<RasterWorkerResponse>) => {
                  const response = event.data;
                  if (response.id !== jobId) return;
                  clearTimeout(timeout);
                  worker.removeEventListener('message', handleMessage);
                  worker.removeEventListener('error', handleError);
                  if (response.type === 'aggregate-grid') {
                    resolve(response.result);
                  } else if (response.type === 'error') {
                    reject(new Error(response.error));
                  } else {
                    reject(new Error('Unexpected worker response type'));
                  }
                };
                const handleError = (event: ErrorEvent) => {
                  clearTimeout(timeout);
                  worker.removeEventListener('message', handleMessage);
                  worker.removeEventListener('error', handleError);
                  reject(new Error(`Worker error: ${event.message}`));
                };
                worker.addEventListener('message', handleMessage);
                worker.addEventListener('error', handleError);
                const timeout = setTimeout(() => {
                  worker.removeEventListener('message', handleMessage);
                  worker.removeEventListener('error', handleError);
                  reject(new Error('Worker aggregation timeout'));
                }, 30000);
                const request: RasterWorkerRequest = {
                  id: jobId,
                  type: 'aggregate-grid',
                  payload: buildAggregateGridPayload({
                    source: sourceFile,
                    sourceKey,
                    fenceRings,
                    metricTransform,
                    gridCellWidth: cellSize,
                    gridCellHeight: cellSize,
                    aggregationMode,
                    rotationDeg: rotation,
                    samples: [0],
                  }),
                };
                worker.postMessage(request);
              });
            } catch (workerError) {
              debugLog('map', 'Worker 网格聚合失败，回退主线程', workerError);
              aggregation = await computeAggregationFallback();
            }
          } else {
            aggregation = await computeAggregationFallback();
          }

          // 全量网格：用于悬停查表与命中数展示
          const fullPreview = buildGridPreview(
            fence.geometry.coordinates,
            cellSize,
            {
              metricTransform,
              aggregation,
              rotationDeg: rotation,
            },
          );

          // 渲染集合按上限降采样。悬停是行列算术 + 查表，不依赖要素是否存在，
          // 因此降采样只影响地图上画多少格，不影响悬停与导出。
          const sampled = fullPreview.cells.length > GRID_RENDER_CELL_BUDGET;
          const renderPreview = sampled
            ? buildGridPreview(fence.geometry.coordinates, cellSize, {
                metricTransform,
                aggregation,
                rotationDeg: rotation,
                maxPreviewCells: GRID_RENDER_CELL_BUDGET,
              })
            : fullPreview;
          const renderSummary = sampled
            ? {
                ...fullPreview.summary,
                // 命中数仍报告真实值，只在提示里说明地图做了采样
                isPreviewLimited: true,
                previewStride: renderPreview.summary.previewStride,
                warning: `当前网格数量约 ${fullPreview.summary.totalCells.toLocaleString()} 个，地图仅预览采样网格（约 ${renderPreview.cells.length.toLocaleString()} 个），导出结果仍完整。`,
              }
            : fullPreview.summary;

          if (disposed) {
            return;
          }

          debugLog('map', '网格聚合预览已更新', {
            cellSize,
            gridCellCount: renderPreview.cells.length,
            aggregationCellCount: Object.keys(aggregation.cellsById).length,
            sampled,
          });
          renderGridPreview(
            renderPreview.cells,
            renderSummary,
            renderPreview,
            false,
            fullPreview.cells,
          );
        } catch (error) {
          if (disposed) {
            return;
          }

          debugLog('map', '网格聚合预览读取失败，回退到几何网格', error);
        } finally {
          useLoadingStore.getState().stop();
        }
      })();
    } catch (error) {
      debugLog('map', '网格预览构建失败', error);
      renderGridPreview([], null);
    }

    return () => {
      disposed = true;
    };
  }, [debouncedCellSize, debouncedRotation, aggregationMode, fence, fenceMode, setPreview, sourceFile]);

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

        let rings = geometry.getCoordinates() as FenceRings;

        if (metadata) {
          const summary = getFenceSummary(rings);
          if (!isBboxInside(summary.bbox, metadata.boundingBox)) {
            rings = clipFenceToBoundingBox(rings, metadata.boundingBox);
          }
        }

        if (validityMask && !isFenceInsideValidityMask(rings, validityMask)) {
          rings = clipFenceToValidityMask(rings, validityMask);
        }

        const outerRing = rings[0] ?? [];
        if (outerRing.length < 4) {
          source.clear();
          setValidationMessage('自动裁剪后围栏无效，请重新绘制。');
          return;
        }

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
      const modify = new Modify({
        source,
        deleteCondition: altKeyOnly,
        style: new Style({
          image: new CircleStyle({
            radius: 6,
            fill: new Fill({ color: '#3388ff' }),
            stroke: new Stroke({ color: '#ffffff', width: 2 }),
          }),
          stroke: new Stroke({
            color: '#3388ff',
            width: 2,
          }),
          fill: new Fill({
            color: 'rgba(51, 136, 255, 0.2)',
          }),
        }),
      });
      modify.on('modifyend', (event) => {
        const geometry = event.features.item(0)?.getGeometry();
        if (!geometry || !(geometry instanceof Polygon)) {
          return;
        }

        let rings = geometry.getCoordinates() as FenceRings;

        if (metadata) {
          const summary = getFenceSummary(rings);
          if (!isBboxInside(summary.bbox, metadata.boundingBox)) {
            rings = clipFenceToBoundingBox(rings, metadata.boundingBox);
          }
        }

        if (validityMask && !isFenceInsideValidityMask(rings, validityMask)) {
          rings = clipFenceToValidityMask(rings, validityMask);
        }

        const outerRing = rings[0] ?? [];
        if (outerRing.length < 4) {
          source.clear();
          if (fence) {
            source.addFeature(
              new Feature({
                geometry: new Polygon(fence.geometry.coordinates),
              }),
            );
          }
          setValidationMessage('自动裁剪后围栏无效，请重新编辑。');
          return;
        }

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

        updateFence(rings);
      });

      map.addInteraction(modify);
      modifyRef.current = modify;
    }
  }, [fence, fenceMode, metadata, setFence, updateFence, setValidationMessage, validityMask]);

  return {
    mapElementRef,
    fitToRaster,
    fitToFence,
  };
}

/**
 * 在下一动画帧中延迟刷新地图尺寸并执行可选回调。
 * 用于容器尺寸变化后（如侧边栏展开/收起、初次挂载）确保 OpenLayers 正确渲染。
 */
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

/**
 * 以下工具函数已迁移至 mapUtils.ts，此处重新导出以保持原有导入路径兼容。
 */
export {
  canClassifySingleBand,
  createAnimationFrameValueScheduler,
  getGridCellStyleColors,
  getPixelPosition,
  getPreviewSampleValues,
  getPrimarySampleValue,
  getVisibleClassificationLayer,
  isBboxInside,
} from './mapUtils';
export type { DeferredMapResizeTarget } from './mapUtils';
