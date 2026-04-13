import { create } from 'zustand';

import { buildDefaultNdviClassificationLayer } from '@/shared/geo/raster';
import type { RasterHoverInfo, RasterRenderSettings } from '@/shared/types/raster';
import type { RasterClassificationLayer } from '@/shared/types/raster';

type LayerKey = 'raster' | 'fence' | 'grid';

type LayerVisibilityState = Record<LayerKey, boolean>;

type ClassificationLayerState = RasterClassificationLayer & {
  visible: boolean;
};

type GradientClassificationLayerState = Extract<ClassificationLayerState, { mode: 'gradient' }>;
type RuleClassificationLayerState = Extract<ClassificationLayerState, { mode: 'rules' }>;

type ClassificationLayerBaseState = Pick<
  ClassificationLayerState,
  'id' | 'label' | 'visible' | 'noDataColor'
>;

type ClassificationLayerUpdates = Partial<ClassificationLayerBaseState> & {
  mode?: RasterClassificationLayer['mode'];
  gradientStops?: GradientClassificationLayerState['gradientStops'];
  rules?: RuleClassificationLayerState['rules'];
};

type MapUiState = {
  layers: LayerVisibilityState;
  hoverInfo: RasterHoverInfo | null;
  rasterRenderSettings: RasterRenderSettings;
  classificationLayers: ClassificationLayerState[];
  activeClassificationLayerId: string | null;
  visibleClassificationLayerId: string | null;
  toggleLayer: (layer: LayerKey) => void;
  setLayerVisibility: (layer: LayerKey, visible: boolean) => void;
  setHoverInfo: (hoverInfo: RasterHoverInfo | null) => void;
  setRasterRenderSettings: (settings: Partial<RasterRenderSettings>) => void;
  addClassificationLayer: (layer: ClassificationLayerState) => void;
  updateClassificationLayer: (layerId: string, updates: ClassificationLayerUpdates) => void;
  duplicateClassificationLayer: (layerId: string) => string | null;
  deleteClassificationLayer: (layerId: string) => void;
  setActiveClassificationLayer: (layerId: string) => void;
  setVisibleClassificationLayer: (layerId: string) => void;
  toggleClassificationLayerVisibility: (layerId: string) => void;
  reset: () => void;
};

const INITIAL_LAYERS: LayerVisibilityState = {
  raster: true,
  fence: true,
  grid: true,
};

const INITIAL_RASTER_RENDER_SETTINGS: RasterRenderSettings = {
  min: null,
  max: null,
  step: 0.2,
};

const DEFAULT_NDVI_CLASSIFICATION_LABEL = 'NDVI 默认';

const DEFAULT_RULE_CLASSIFICATION_LAYER: Extract<RasterClassificationLayer, { mode: 'rules' }> = {
  id: 'classification-rules-default',
  label: '默认规则',
  mode: 'rules',
  noDataColor: '#00000000',
  gradientStops: [],
  rules: [
    { min: -1, max: 0, color: '#cccccc', label: '低值' },
    { min: 0, max: null, color: '#226622', label: '高值' },
  ],
};

function buildDefaultGradientClassificationLayer(): GradientClassificationLayerState {
  const layer = buildDefaultNdviClassificationLayer();

  if (layer.mode !== 'gradient') {
    throw new Error('Expected default NDVI classification layer to use gradient mode.');
  }

  return {
    ...layer,
    label: DEFAULT_NDVI_CLASSIFICATION_LABEL,
    visible: true,
  };
}

function cloneGradientStops(
  [firstStop, ...restStops]: GradientClassificationLayerState['gradientStops'],
): GradientClassificationLayerState['gradientStops'] {
  return [
    { ...firstStop },
    ...restStops.map((stop) => ({ ...stop })),
  ];
}

function cloneRules(
  [firstRule, ...restRules]: RuleClassificationLayerState['rules'],
): RuleClassificationLayerState['rules'] {
  return [
    { ...firstRule },
    ...restRules.map((rule) => ({ ...rule })),
  ];
}

function createGradientClassificationLayer(
  base: ClassificationLayerBaseState,
  gradientStops: GradientClassificationLayerState['gradientStops'],
): GradientClassificationLayerState {
  return {
    ...base,
    mode: 'gradient',
    gradientStops,
    rules: [],
  };
}

function createRuleClassificationLayer(
  base: ClassificationLayerBaseState,
  rules: RuleClassificationLayerState['rules'],
): RuleClassificationLayerState {
  return {
    ...base,
    mode: 'rules',
    gradientStops: [],
    rules,
  };
}

function cloneClassificationLayer(
  layer: ClassificationLayerState,
  overrides: Partial<ClassificationLayerBaseState> = {},
): ClassificationLayerState {
  const base: ClassificationLayerBaseState = {
    id: overrides.id ?? layer.id,
    label: overrides.label ?? layer.label,
    visible: overrides.visible ?? layer.visible,
    noDataColor: overrides.noDataColor ?? layer.noDataColor,
  };

  if (layer.mode === 'rules') {
    return createRuleClassificationLayer(base, cloneRules(layer.rules));
  }

  return createGradientClassificationLayer(base, cloneGradientStops(layer.gradientStops));
}

function createInitialClassificationLayer(): ClassificationLayerState {
  return cloneClassificationLayer(buildDefaultGradientClassificationLayer());
}

function buildClassificationLayerBase(
  layer: ClassificationLayerState,
  updates: ClassificationLayerUpdates,
  existingLayers: ClassificationLayerState[],
): ClassificationLayerBaseState {
  const hasConflictingId =
    updates.id != null &&
    updates.id !== layer.id &&
    existingLayers.some((existingLayer) => existingLayer.id === updates.id);

  return {
    id: hasConflictingId ? layer.id : updates.id ?? layer.id,
    label: updates.label ?? layer.label,
    visible: updates.visible ?? layer.visible,
    noDataColor: updates.noDataColor ?? layer.noDataColor,
  };
}

function resolveGradientStops(
  layer: ClassificationLayerState,
  updates: ClassificationLayerUpdates,
): GradientClassificationLayerState['gradientStops'] {
  if (updates.gradientStops != null) {
    return cloneGradientStops(updates.gradientStops);
  }

  if (layer.mode === 'gradient') {
    return cloneGradientStops(layer.gradientStops);
  }

  return cloneGradientStops(buildDefaultGradientClassificationLayer().gradientStops);
}

function resolveRules(
  layer: ClassificationLayerState,
  updates: ClassificationLayerUpdates,
): RuleClassificationLayerState['rules'] {
  if (updates.rules != null) {
    return cloneRules(updates.rules);
  }

  if (layer.mode === 'rules') {
    return cloneRules(layer.rules);
  }

  return cloneRules(DEFAULT_RULE_CLASSIFICATION_LAYER.rules);
}

function buildNormalizedClassificationLayer(
  layer: ClassificationLayerState,
  updates: ClassificationLayerUpdates,
  existingLayers: ClassificationLayerState[],
): ClassificationLayerState {
  const base = buildClassificationLayerBase(layer, updates, existingLayers);
  const nextMode = updates.mode ?? layer.mode;

  if (nextMode === 'gradient') {
    return createGradientClassificationLayer(base, resolveGradientStops(layer, updates));
  }

  return createRuleClassificationLayer(base, resolveRules(layer, updates));
}

function buildInitialClassificationState() {
  const defaultLayer = createInitialClassificationLayer();

  return {
    classificationLayers: [defaultLayer],
    activeClassificationLayerId: defaultLayer.id,
    visibleClassificationLayerId: defaultLayer.id,
  };
}

function getVisibleClassificationLayerId(
  classificationLayers: ClassificationLayerState[],
  preferredLayerId: string | null,
): string | null {
  if (preferredLayerId) {
    const preferredLayer = classificationLayers.find((layer) => layer.id === preferredLayerId);
    if (preferredLayer?.visible) {
      return preferredLayer.id;
    }
  }

  return classificationLayers.find((layer) => layer.visible)?.id ?? null;
}

function getActiveClassificationLayerId(
  classificationLayers: ClassificationLayerState[],
  preferredLayerId: string | null,
): string | null {
  if (preferredLayerId && classificationLayers.some((layer) => layer.id === preferredLayerId)) {
    return preferredLayerId;
  }

  return classificationLayers[0]?.id ?? null;
}

function createDuplicateLayerId(
  classificationLayers: ClassificationLayerState[],
  sourceLayerId: string,
): string {
  let suffix = 1;
  let nextId = `${sourceLayerId}-copy-${suffix}`;

  while (classificationLayers.some((layer) => layer.id === nextId)) {
    suffix += 1;
    nextId = `${sourceLayerId}-copy-${suffix}`;
  }

  return nextId;
}

export const useMapUiStore = create<MapUiState>((set) => ({
  ...buildInitialClassificationState(),
  layers: INITIAL_LAYERS,
  hoverInfo: null,
  rasterRenderSettings: INITIAL_RASTER_RENDER_SETTINGS,
  toggleLayer: (layer) =>
    set((state) => ({
      layers: {
        ...state.layers,
        [layer]: !state.layers[layer],
      },
    })),
  setLayerVisibility: (layer, visible) =>
    set((state) => ({
      layers: {
        ...state.layers,
        [layer]: visible,
      },
    })),
  setHoverInfo: (hoverInfo) => set({ hoverInfo }),
  setRasterRenderSettings: (settings) =>
    set((state) => ({
      rasterRenderSettings: {
        ...state.rasterRenderSettings,
        ...settings,
      },
    })),
  addClassificationLayer: (layer) =>
    set((state) => {
      const classificationLayers = [...state.classificationLayers, cloneClassificationLayer(layer)];

      return {
        classificationLayers,
        activeClassificationLayerId: getActiveClassificationLayerId(
          classificationLayers,
          state.activeClassificationLayerId,
        ),
        visibleClassificationLayerId: getVisibleClassificationLayerId(
          classificationLayers,
          state.visibleClassificationLayerId,
        ),
      };
    }),
  updateClassificationLayer: (layerId, updates) =>
    set((state) => {
      const currentLayer = state.classificationLayers.find((layer) => layer.id === layerId);
      if (!currentLayer) {
        return state;
      }

      const nextLayer = buildNormalizedClassificationLayer(
        currentLayer,
        updates,
        state.classificationLayers.filter((layer) => layer.id !== layerId),
      );
      const classificationLayers = state.classificationLayers.map((layer) =>
        layer.id === layerId ? nextLayer : layer,
      );

      return {
        classificationLayers,
        activeClassificationLayerId: getActiveClassificationLayerId(
          classificationLayers,
          state.activeClassificationLayerId === layerId ? nextLayer.id : state.activeClassificationLayerId,
        ),
        visibleClassificationLayerId: getVisibleClassificationLayerId(
          classificationLayers,
          state.visibleClassificationLayerId === layerId ? nextLayer.id : state.visibleClassificationLayerId,
        ),
      };
    }),
  duplicateClassificationLayer: (layerId) =>
    {
      let duplicatedLayerId: string | null = null;

      set((state) => {
        const sourceLayer = state.classificationLayers.find((layer) => layer.id === layerId);
        if (!sourceLayer) {
          return state;
        }

        duplicatedLayerId = createDuplicateLayerId(state.classificationLayers, sourceLayer.id);
        const duplicateLayer = cloneClassificationLayer(sourceLayer, {
          id: duplicatedLayerId,
          label: `${sourceLayer.label} 副本`,
        });
        const classificationLayers = [...state.classificationLayers, duplicateLayer];

        return {
          classificationLayers,
          activeClassificationLayerId: getActiveClassificationLayerId(
            classificationLayers,
            state.activeClassificationLayerId,
          ),
          visibleClassificationLayerId: getVisibleClassificationLayerId(
            classificationLayers,
            state.visibleClassificationLayerId,
          ),
        };
      });

      return duplicatedLayerId;
    },
  deleteClassificationLayer: (layerId) =>
    set((state) => {
      const deletedIndex = state.classificationLayers.findIndex((layer) => layer.id === layerId);
      if (deletedIndex === -1) {
        return state;
      }

      const classificationLayers = state.classificationLayers.filter((layer) => layer.id !== layerId);
      const fallbackLayer =
        classificationLayers[deletedIndex] ?? classificationLayers[classificationLayers.length - 1] ?? null;

      return {
        classificationLayers,
        activeClassificationLayerId:
          state.activeClassificationLayerId === layerId
            ? fallbackLayer?.id ?? null
            : getActiveClassificationLayerId(classificationLayers, state.activeClassificationLayerId),
        visibleClassificationLayerId: getVisibleClassificationLayerId(
          classificationLayers,
          state.visibleClassificationLayerId === layerId
            ? fallbackLayer?.id ?? null
            : state.visibleClassificationLayerId,
        ),
      };
    }),
  setActiveClassificationLayer: (layerId) =>
    set((state) => ({
      activeClassificationLayerId: getActiveClassificationLayerId(
        state.classificationLayers,
        layerId,
      ),
    })),
  setVisibleClassificationLayer: (layerId) =>
    set((state) => {
      const classificationLayers = state.classificationLayers.map((layer) =>
        layer.id === layerId && !layer.visible ? { ...layer, visible: true } : layer,
      );

      return {
        classificationLayers,
        visibleClassificationLayerId: getVisibleClassificationLayerId(classificationLayers, layerId),
      };
    }),
  toggleClassificationLayerVisibility: (layerId) =>
    set((state) => {
      const classificationLayers = state.classificationLayers.map((layer) =>
        layer.id === layerId ? { ...layer, visible: !layer.visible } : layer,
      );

      const toggledLayer = classificationLayers.find((layer) => layer.id === layerId);
      const preferredLayerId =
        toggledLayer?.visible
          ? toggledLayer.id
          : state.visibleClassificationLayerId === layerId
            ? null
            : state.visibleClassificationLayerId;

      return {
        classificationLayers,
        visibleClassificationLayerId: getVisibleClassificationLayerId(
          classificationLayers,
          preferredLayerId,
        ),
      };
    }),
  reset: () =>
    set({
      ...buildInitialClassificationState(),
      layers: INITIAL_LAYERS,
      hoverInfo: null,
      rasterRenderSettings: INITIAL_RASTER_RENDER_SETTINGS,
    }),
}));
