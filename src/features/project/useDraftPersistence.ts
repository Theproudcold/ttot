/**
 * 把当前工作状态持续写入本地草稿。
 *
 * 该 hook 只订阅 store 并写草稿，不负责「是否恢复」的交互——
 * 恢复提示与实际还原由界面层在拿到 `readDraft()` 结果后决定。
 * 后续接入 App 时调用一次即可。
 */

import { useEffect } from 'react';

import { useFenceStore } from '@/features/fence/fenceStore';
import { useGridStore } from '@/features/grid/gridStore';
import { useMapUiStore } from '@/features/map/mapUiStore';
import { useRasterStore } from '@/features/map/rasterStore';

import { createDraftScheduler } from './draftStorage';
import { exportProjectSnapshot } from './projectSnapshot';

export function useDraftPersistence(enabled = true): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const scheduler = createDraftScheduler();

    const persist = () => {
      const raster = useRasterStore.getState();
      const fence = useFenceStore.getState();
      const grid = useGridStore.getState();
      const mapUi = useMapUiStore.getState();

      scheduler.schedule(
        exportProjectSnapshot({
          sourceFile: raster.sourceFile,
          sourceLabel: raster.sourceLabel,
          metadata: raster.metadata,
          fenceRings: fence.fence?.geometry.coordinates ?? null,
          grid: {
            cellSize: grid.cellSize,
            rotation: grid.rotation,
            aggregationMode: grid.aggregationMode,
          },
          classification: {
            layers: mapUi.classificationLayers,
            activeLayerId: mapUi.activeClassificationLayerId,
            visibleLayerId: mapUi.visibleClassificationLayerId,
          },
          view: {
            layers: mapUi.layers,
            gridRenderSettings: mapUi.gridRenderSettings,
          },
        }),
      );
    };

    const unsubscribers = [
      useRasterStore.subscribe(persist),
      useFenceStore.subscribe(persist),
      useGridStore.subscribe(persist),
      useMapUiStore.subscribe(persist),
    ];

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      // 卸载（含刷新）前落盘最后一次状态
      scheduler.flush();
    };
  }, [enabled]);
}
