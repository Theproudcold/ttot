import { useEffect, type RefObject } from 'react';

import Feature from 'ol/Feature.js';
import type Map from 'ol/Map.js';
import Polygon from 'ol/geom/Polygon.js';
import Draw from 'ol/interaction/Draw.js';
import Modify from 'ol/interaction/Modify.js';
import type VectorSource from 'ol/source/Vector.js';
import { altKeyOnly } from 'ol/events/condition.js';
import { Circle as CircleStyle, Fill, Stroke, Style } from 'ol/style.js';

import { getFenceSummary, isFenceInsideValidityMask } from '@/shared/geo/fence';
import { clipFenceToBoundingBox, clipFenceToValidityMask } from '@/shared/geo/fence';
import type { FenceFeature, FenceRings } from '@/shared/types/fence';
import type { RasterMetadata, RasterValidityMask } from '@/shared/types/raster';

import { isBboxInside } from './mapUtils';

/**
 * 围栏绘制（Draw）与编辑（Modify）交互。
 *
 * 从 `useMap` 拆出：这是唯一一处「把用户的地图操作翻译成围栏状态」的逻辑，
 * 与渲染、Worker、悬停无关。抽出来后改围栏行为不必通读 useMap。
 *
 * 职责：
 * - 按 `fenceMode` 挂载 Draw 或 Modify 交互；
 * - Draw 结束时校验围栏是否落在影像/有效数据范围内；
 * - Modify 结束时自动裁剪到影像边界与有效数据掩码，裁剪失败则回滚。
 */
export function useFenceInteractions(input: {
  mapRef: RefObject<Map | null>;
  fenceSourceRef: RefObject<VectorSource | null>;
  drawRef: RefObject<Draw | null>;
  modifyRef: RefObject<Modify | null>;
  removeInteractions: () => void;
  metadata: RasterMetadata | null;
  validityMask: RasterValidityMask | null;
  fence: FenceFeature | null;
  fenceMode: 'idle' | 'draw' | 'edit';
  setFence: (rings: FenceRings) => void;
  updateFence: (rings: FenceRings) => void;
  setValidationMessage: (message: string | null) => void;
}): void {
  const {
    mapRef,
    fenceSourceRef,
    drawRef,
    modifyRef,
    removeInteractions,
    metadata,
    validityMask,
    fence,
    fenceMode,
    setFence,
    updateFence,
    setValidationMessage,
  } = input;

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
}
