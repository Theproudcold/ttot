/**
 * 工程配方的应用层：**唯一有副作用的一层**。
 *
 * 解析、校验、转换为补丁都在 `projectSnapshot.ts` 中以纯函数完成，
 * 本模块只负责把补丁写进各个 store，便于对纯函数单独做往返测试。
 */

import { useFenceStore } from '@/features/fence/fenceStore';
import { useGridStore } from '@/features/grid/gridStore';
import { useMapUiStore } from '@/features/map/mapUiStore';

import type { ProjectSnapshotV1, ProjectStorePatches } from './projectSnapshot';
import { toStorePatches } from './projectSnapshot';

/**
 * 把补丁写入各 store。
 *
 * 顺序要求：先分类方案与视图，再围栏，最后网格参数。
 * useMap 的网格预览 effect 依赖 fence / cellSize / rotation / aggregationMode，
 * 一次性写完再让它跑一轮，避免拖拽式的中途重算。
 */
export function applyStorePatches(patches: ProjectStorePatches): void {
  useMapUiStore.getState().restoreUiState({
    layers: patches.view.layers,
    gridRenderSettings: patches.view.gridRenderSettings,
    classificationLayers: patches.classification.layers,
    activeClassificationLayerId: patches.classification.activeLayerId,
    visibleClassificationLayerId: patches.classification.visibleLayerId,
  });

  const fenceStore = useFenceStore.getState();
  if (patches.fenceRings) {
    fenceStore.setFence(patches.fenceRings);
  } else {
    fenceStore.clearFence();
  }

  useGridStore.getState().restoreGrid(patches.grid);
}

export function applyProjectSnapshot(snapshot: ProjectSnapshotV1): void {
  applyStorePatches(toStorePatches(snapshot));
}
