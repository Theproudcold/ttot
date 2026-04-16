import { useEffect, useRef } from 'react';

import Feature from 'ol/Feature.js';
import Map from 'ol/Map.js';
import type MapBrowserEvent from 'ol/MapBrowserEvent.js';
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
import { buildGridAggregationFromFenceWindowAsync, readGeoTiffFenceWindow } from '@/shared/geo/geotiffExport';
import { buildGridPreview } from '@/shared/geo/grid';
import {
  buildRasterClassificationPreviewRgba,
  createPreviewDataUrl,
  findRasterClassificationMatch,
} from '@/shared/geo/raster';
import type { RasterMetadata, RasterWorkerRequest, RasterWorkerResponse } from '@/shared/types/raster';
import type { RasterClassificationLayer } from '@/shared/types/raster';
import type { FenceRings } from '@/shared/types/fence';
import type { GridCell, GridRenderSettings } from '@/shared/types/grid';

import { useRasterStore } from './rasterStore';
import {
  type DeferredMapResizeTarget,
  type GridCellHitTester,
  createAnimationFrameValueScheduler,
  createGridCellHitTester,
  getGridCellStyleColors,
  getPixelPosition,
  getPreviewSampleValues,
  getPrimarySampleValue,
  getVisibleClassificationLayer,
  isBboxInside,
} from './mapUtils';

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
  const gridLayerRef = useRef<VectorLayer | null>(null);
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
  const gridHitTesterRef = useRef<GridCellHitTester>(() => null);
  const gridRenderSettingsRef = useRef(gridRenderSettings);
  const visibleClassificationLayerRef = useRef(
    getVisibleClassificationLayer(classificationLayers, visibleClassificationLayerId),
  );
  const gridStyleCacheRef = useRef<globalThis.Map<string, Style>>(new globalThis.Map());
  const workerRef = useRef<Worker | null>(null);
  const previewJobIdRef = useRef(0);
  const aggregationJobIdRef = useRef(0);

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

    return () => {
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

  useEffect(() => {
    if (!fence || gridCells.length === 0) {
      gridHitTesterRef.current = () => null;
      return;
    }

    gridHitTesterRef.current = createGridCellHitTester({
      cells: gridCells,
      fenceRings: fence.geometry.coordinates,
      cellSize,
      metricTransform: metadata?.metricTransform,
    });
  }, [cellSize, fence, gridCells, metadata]);

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
    const gridLayer = new VectorLayer({
      source: gridSource,
      visible: layers.grid,
      zIndex: 2,
      style: (feature) => {
        const cell = feature.get('gridCell') as GridCell | undefined;
        if (!cell) {
          return new Style({
            stroke: new Stroke({ color: 'rgba(0, 0, 0, 0)', width: 1 }),
            fill: new Fill({ color: 'rgba(0, 0, 0, 0)' }),
          });
        }

        const outputValue = cell.aggregation?.outputValue;
        const cacheKey = `${cell.id}-${outputValue ?? 'na'}`;
        const cached = gridStyleCacheRef.current.get(cacheKey);
        if (cached) return cached;

        const colors = getGridCellStyleColors(cell, visibleClassificationLayerRef.current, gridRenderSettingsRef.current);
        const style = new Style({
          stroke: new Stroke({
            color: colors.strokeColor,
            width: gridRenderSettingsRef.current.strokeWidth,
          }),
          fill: new Fill({
            color: colors.fillColor,
          }),
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
      const hitGridCell = gridHitTesterRef.current(coordinate);
      const visibleClassificationLayer = visibleClassificationLayerRef.current;
      const classificationMatch =
        currentPreview.sampleBandCount === 1 && visibleClassificationLayer
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
        preview.sampleBandCount === 1 &&
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
        preview.sampleBandCount === 1 &&
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
    gridLayerRef.current?.setVisible(layers.grid);
  }, [layers.grid]);

  useEffect(() => {
    gridStyleCacheRef.current.clear();
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

    const renderGridPreview = (cells: GridCell[], summary: ReturnType<typeof buildGridPreview>['summary'] | null) => {
      source.clear();
      setPreview(cells, summary);

      const features = cells.map(
        (cell) =>
          new Feature({
            geometry: new Polygon(cell.polygon),
            gridCell: cell,
          }),
      );
      source.addFeatures(features);
    };

    if (!fence) {
      renderGridPreview([], null);
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
          maxPreviewCells: 50_000,
        }),
      );
      renderGridPreview(basePreview.cells, basePreview.summary);

      if (!sourceFile) {
        return () => {
          disposed = true;
        };
      }

      void (async () => {
        try {
          useLoadingStore.getState().start('正在计算网格聚合...');
          const fenceWindow = await measurePerformanceAsync('raster:fence-window', () =>
            readGeoTiffFenceWindow({
              file: sourceFile,
              fenceRings: fence.geometry.coordinates,
              samples: [0],
            }),
          );
          if (disposed) {
            return;
          }

          useLoadingStore.getState().update('正在汇总网格像元...');
          let aggregation: import('@/shared/types/grid').GridAggregationResult;

          const computeAggregationFallback = () =>
            measurePerformanceAsync('grid:aggregation', () =>
              buildGridAggregationFromFenceWindowAsync(
                {
                  ...fenceWindow,
                  fenceRings: fence.geometry.coordinates,
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
            );

          if (workerRef.current) {
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
                const primaryBand = fenceWindow.bands[0];
                if (!primaryBand) {
                  clearTimeout(timeout);
                  worker.removeEventListener('message', handleMessage);
                  worker.removeEventListener('error', handleError);
                  reject(new Error('GeoTIFF 缺少主波段数据'));
                  return;
                }
                worker.postMessage({
                  id: jobId,
                  type: 'aggregate-grid',
                  payload: {
                    fenceRings: fence.geometry.coordinates,
                    window: fenceWindow.window,
                    width: fenceWindow.width,
                    height: fenceWindow.height,
                    origin: fenceWindow.origin,
                    resolution: fenceWindow.resolution,
                    band: Float32Array.from(primaryBand),
                    noDataValue: fenceWindow.sourceNoDataValue,
                    metricTransform: metricTransform ?? null,
                    gridCellWidth: cellSize,
                    gridCellHeight: cellSize,
                    aggregationMode,
                    rotationDeg: rotation,
                  },
                } satisfies RasterWorkerRequest);
              });
            } catch (workerError) {
              debugLog('map', 'Worker 网格聚合失败，回退主线程', workerError);
              aggregation = await computeAggregationFallback();
            }
          } else {
            aggregation = await computeAggregationFallback();
          }

          const nextPreview = buildGridPreview(
            fence.geometry.coordinates,
            cellSize,
            {
              metricTransform,
              aggregation,
              rotationDeg: rotation,
            },
          );

          if (disposed) {
            return;
          }

          debugLog('map', '网格聚合预览已更新', {
            cellSize,
            gridCellCount: nextPreview.cells.length,
            aggregationCellCount: Object.keys(aggregation.cellsById).length,
          });
          renderGridPreview(nextPreview.cells, nextPreview.summary);
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
  }, [cellSize, rotation, aggregationMode, fence, setPreview, sourceFile]);

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
      const modify = new Modify({ source });
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
  createAnimationFrameValueScheduler,
  createGridCellHitTester,
  getGridCellStyleColors,
  getPixelPosition,
  getPreviewSampleValues,
  getPrimarySampleValue,
  getVisibleClassificationLayer,
  isBboxInside,
} from './mapUtils';
export type { DeferredMapResizeTarget, GridCellHitTester } from './mapUtils';
