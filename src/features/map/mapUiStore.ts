import { create } from 'zustand';

import type { RasterHoverInfo, RasterRenderSettings } from '@/shared/types/raster';

type LayerKey = 'raster' | 'fence' | 'grid';

type LayerVisibilityState = Record<LayerKey, boolean>;

type MapUiState = {
  layers: LayerVisibilityState;
  hoverInfo: RasterHoverInfo | null;
  rasterRenderSettings: RasterRenderSettings;
  toggleLayer: (layer: LayerKey) => void;
  setLayerVisibility: (layer: LayerKey, visible: boolean) => void;
  setHoverInfo: (hoverInfo: RasterHoverInfo | null) => void;
  setRasterRenderSettings: (settings: Partial<RasterRenderSettings>) => void;
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

export const useMapUiStore = create<MapUiState>((set) => ({
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
  reset: () =>
    set({
      layers: INITIAL_LAYERS,
      hoverInfo: null,
      rasterRenderSettings: INITIAL_RASTER_RENDER_SETTINGS,
    }),
}));
