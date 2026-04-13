import { create } from 'zustand';

import { buildFenceFeature } from '@/shared/geo/fence';
import type { FenceFeature, FenceMode, FenceRings } from '@/shared/types/fence';

type FenceState = {
  mode: FenceMode;
  fence: FenceFeature | null;
  validationMessage: string | null;
  startDraw: () => void;
  startEdit: () => void;
  setFence: (rings: FenceRings) => void;
  setValidationMessage: (message: string | null) => void;
  clearFence: () => void;
  reset: () => void;
};

const INITIAL_STATE = {
  mode: 'idle' as FenceMode,
  fence: null as FenceFeature | null,
  validationMessage: null as string | null,
};

export const useFenceStore = create<FenceState>((set) => ({
  ...INITIAL_STATE,
  startDraw: () => set({ mode: 'draw', validationMessage: null }),
  startEdit: () => set({ mode: 'edit', validationMessage: null }),
  setFence: (rings) =>
    set({
      fence: buildFenceFeature(rings),
      mode: 'idle',
      validationMessage: null,
    }),
  setValidationMessage: (validationMessage) => set({ validationMessage }),
  clearFence: () =>
    set({
      fence: null,
      mode: 'idle',
      validationMessage: null,
    }),
  reset: () => set(INITIAL_STATE),
}));
