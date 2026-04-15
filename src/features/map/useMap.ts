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
import { useLoadingStore } from '@/features/loading/loadingStore';
import { buildMapViewDebugPayload, debugLog, summarizePreviewPayload } from '@/features/map/debugLogger';
import { useMapUiStore } from '@/features/map/mapUiStore';
import { ensureProjectionRegistered, getDegreeToMeterScale } from '@/shared/geo/crs';
import { clipFenceToBoundingBox, clipFenceToValidityMask, getFenceSummary, isCoordinateInValidityMask, isFenceInsideValidityMask, isPointInFence } from '@/shared/geo/fence';
import { buildGridAggregationFromFenceWindow, readGeoTiffFenceWindow } from '@/shared/geo/geotiffExport';
import { buildGridPreview } from '@/shared/geo/grid';
import {
  buildRasterClassificationPreviewRgba,
  createPreviewDataUrl,
  findRasterClassificationMatch,
} from '@/shared/geo/raster';
import type { RasterMetadata } from '@/shared/types/raster';
import type { RasterClassificationLayer } from '@/shared/types/raster';
import type { FenceRings } from '@/shared/types/fence';
import type { GridCell, GridRenderSettings } from '@/shared/types/grid';

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

function findGridCellAtCoordinate(coordinate: [number, number], cells: GridCell[]): GridCell | null {
  for (const cell of cells) {
    if (isPointInFence(coordinate, cell.polygon)) {
      return cell;
    }
  }

  return null;
}

function hexToRgba(hex: string, alpha: number): string {
  const sanitized = hex.replace('#', '');
  const r = Number.parseInt(sanitized.substring(0, 2), 16);
  const g = Number.parseInt(sanitized.substring(2, 4), 16);
  const b = Number.parseInt(sanitized.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function getGridCellStyleColors(
  cell: GridCell,
  visibleClassificationLayer: (RasterClassificationLayer & { visible: boolean }) | null,
  gridRenderSettings: GridRenderSettings,
): { strokeColor: string; fillColor: string } {
  if (!gridRenderSettings.useClassificationColors) {
    return {
      strokeColor: hexToRgba(gridRenderSettings.strokeColor, gridRenderSettings.strokeOpacity),
      fillColor: hexToRgba(gridRenderSettings.fillColor, gridRenderSettings.fillOpacity),
    };
  }

  const outputValue = cell.aggregation?.outputValue;
  if (outputValue === null || outputValue === undefined || !Number.isFinite(outputValue)) {
    return {
      strokeColor: 'rgba(0, 0, 0, 0)',
      fillColor: 'rgba(0, 0, 0, 0)',
    };
  }

  return {
    strokeColor: 'rgba(0, 0, 0, 0.18)',
    fillColor:
      findRasterClassificationMatch(
        outputValue,
        visibleClassificationLayer ?? useMapUiStore.getState().classificationLayers[0],
      )?.color ?? 'rgba(17, 17, 17, 0.18)',
  };
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

function getVisibleClassificationLayer(
  classificationLayers: Array<RasterClassificationLayer & { visible: boolean }>,
  visibleClassificationLayerId: string | null,
): (RasterClassificationLayer & { visible: boolean }) | null {
  if (visibleClassificationLayerId) {
    const preferredLayer = classificationLayers.find((layer) => layer.id === visibleClassificationLayerId);
    if (preferredLayer?.visible) {
      return preferredLayer;
    }
  }

  return classificationLayers.find((layer) => layer.visible) ?? null;
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
  const gridCells = useGridStore((state) => state.cells);
  const setPreview = useGridStore((state) => state.setPreview);
  const gridRenderSettings = useMapUiStore((state) => state.gridRenderSettings);

  const previewRef = useRef(preview);
  const validityMaskRef = useRef(validityMask);
  const fenceRef = useRef(fence);
  const gridCellsRef = useRef(gridCells);
  const gridRenderSettingsRef = useRef(gridRenderSettings);
  const visibleClassificationLayerRef = useRef(
    getVisibleClassificationLayer(classificationLayers, visibleClassificationLayerId),
  );

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
    gridRenderSettingsRef.current = gridRenderSettings;
  }, [gridRenderSettings]);

  useEffect(() => {
    visibleClassificationLayerRef.current = getVisibleClassificationLayer(
      classificationLayers,
      visibleClassificationLayerId,
    );
  }, [classificationLayers, visibleClassificationLayerId]);

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
      zIndex: 2,
      style: (feature) => {
        const cell = feature.get('gridCell') as GridCell | undefined;
        const colors = cell
          ? getGridCellStyleColors(cell, visibleClassificationLayerRef.current, gridRenderSettingsRef.current)
          : {
              strokeColor: 'rgba(0, 0, 0, 0)',
              fillColor: 'rgba(0, 0, 0, 0)',
            };

        return new Style({
          stroke: new Stroke({
            color: colors.strokeColor,
            width: gridRenderSettingsRef.current.strokeWidth,
          }),
          fill: new Fill({
            color: colors.fillColor,
          }),
        });
      },
    });
    map.addLayer(gridLayer);
    map.addLayer(fenceLayer);

    map.on('pointermove', (event) => {
      const currentMetadata = metadataRef.current;
      const currentPreview = previewRef.current;
      const currentValidityMask = validityMaskRef.current;
      const currentFence = fenceRef.current;
      const currentGridCells = gridCellsRef.current;

      const [x, y] = event.coordinate;
      const isDegree = currentMetadata?.cellSize.unit === 'degree';
      const decimals = isDegree ? 6 : 3;
      setPointerText(`${x.toFixed(decimals)}, ${y.toFixed(decimals)}`);

      if (!currentMetadata || !currentPreview) {
        setHoverInfo(null);
        return;
      }

      const coordinate: [number, number] = [x, y];
      const sampleValues = getPreviewSampleValues(coordinate, currentMetadata, currentPreview);
      const primarySampleValue = getPrimarySampleValue(sampleValues, currentPreview.noDataValue);
      const hitGridCell = findGridCellAtCoordinate(coordinate, currentGridCells);
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
        gridMeanValue: hitGridCell?.aggregation?.meanValue ?? null,
        gridValidPixelCount: hitGridCell?.aggregation?.validPixelCount ?? null,
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

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        stopInteraction();
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
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

    const visibleClassificationLayer = getVisibleClassificationLayer(
      classificationLayers,
      visibleClassificationLayerId,
    );
    const styledPreviewUrl =
      preview.sampleBandCount === 1 && preview.sampleData && visibleClassificationLayer
        ? createPreviewDataUrl(
            preview.width,
            preview.height,
            buildRasterClassificationPreviewRgba(
              preview.sampleData,
              preview.width,
              preview.height,
              visibleClassificationLayer,
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
      zIndex: 0,
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
  }, [classificationLayers, layers.raster, metadata, preview, visibleClassificationLayerId]);

  useEffect(() => {
    fenceLayerRef.current?.setVisible(layers.fence);
  }, [layers.fence]);

  useEffect(() => {
    gridLayerRef.current?.setVisible(layers.grid);
  }, [layers.grid]);

  useEffect(() => {
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

      for (const cell of cells) {
        source.addFeature(
          new Feature({
            geometry: new Polygon(cell.polygon),
            gridCell: cell,
          }),
        );
      }
    };

    if (!fence) {
      renderGridPreview([], null);
      return () => {
        disposed = true;
      };
    }

    try {
      const metricTransform = metadata?.metricTransform;
      let cellWidth = cellSize;
      let cellHeight = cellSize;
      const isDegree = metadata?.cellSize.unit === 'degree';
      
      if (isDegree) {
        const centerLat = fence.geometry.coordinates[0]?.[0]?.[1] ?? 0;
        const scale = getDegreeToMeterScale(centerLat);
        cellWidth = cellSize / scale.scaleX;
        cellHeight = cellSize / scale.scaleY;
      }

      const basePreview = buildGridPreview(fence.geometry.coordinates, cellSize, {
        metricTransform,
        rotationDeg: rotation,
      });
      renderGridPreview(basePreview.cells, basePreview.summary);

      if (!sourceFile) {
        return () => {
          disposed = true;
        };
      }

      void (async () => {
        try {
          useLoadingStore.getState().start('正在计算网格聚合...');
          const fenceWindow = await readGeoTiffFenceWindow({
            file: sourceFile,
            fenceRings: fence.geometry.coordinates,
            samples: [0],
          });
          if (disposed) {
            return;
          }

          const aggregation = buildGridAggregationFromFenceWindow({
            ...fenceWindow,
            fenceRings: fence.geometry.coordinates,
            metricTransform,
            gridCellWidth: cellWidth,
            gridCellHeight: cellHeight,
          });
          const nextPreview = buildGridPreview(fence.geometry.coordinates, cellSize, {
            metricTransform,
            aggregation,
            rotationDeg: rotation,
          });

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
  }, [cellSize, rotation, fence, setPreview, sourceFile]);

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
