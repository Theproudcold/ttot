import { create } from 'zustand';

import type {
  RasterLoadStatus,
  RasterMetadata,
  RasterPreview,
  RasterValidityMask,
} from '@/shared/types/raster';

type ValidityLoadStatus = 'idle' | 'loading' | 'ready' | 'error';
type PreviewLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

type RasterState = {
  sourceFile: File | null;
  sourceLabel: string;
  sourceId: number;
  metadata: RasterMetadata | null;
  preview: RasterPreview | null;
  previewStatus: PreviewLoadStatus;
  validityMask: RasterValidityMask | null;
  validityStatus: ValidityLoadStatus;
  status: RasterLoadStatus;
  error: string | null;
  pointerText: string;
  loadingPhase: string;
  loadingProgress: number | null;
  selectFile: (file: File) => void;
  setMetadata: (metadata: RasterMetadata) => void;
  setPreview: (preview: RasterPreview | null) => void;
  setPreviewStatus: (status: PreviewLoadStatus) => void;
  setValidityMask: (validityMask: RasterValidityMask | null) => void;
  setValidityStatus: (status: ValidityLoadStatus) => void;
  setStatus: (status: RasterLoadStatus) => void;
  setError: (error: string | null) => void;
  setPointerText: (pointerText: string) => void;
  setLoadingProgress: (loadingPhase: string, loadingProgress: number | null) => void;
  reset: () => void;
};

const INITIAL_STATE = {
  sourceFile: null,
  sourceLabel: '未选择文件',
  sourceId: 0,
  metadata: null,
  preview: null,
  previewStatus: 'idle' as PreviewLoadStatus,
  validityMask: null,
  validityStatus: 'idle' as ValidityLoadStatus,
  status: 'idle' as RasterLoadStatus,
  error: null,
  pointerText: '--',
  loadingPhase: '等待上传',
  loadingProgress: null,
};

export const useRasterStore = create<RasterState>((set) => ({
  ...INITIAL_STATE,
  selectFile: (file) =>
    set((state) => ({
      sourceFile: file,
      sourceLabel: file.name,
      sourceId: state.sourceId + 1,
      metadata: null,
      preview: null,
      previewStatus: 'idle',
      validityMask: null,
      validityStatus: 'idle',
      status: 'idle',
      error: null,
      pointerText: '--',
      loadingPhase: '等待读取',
      loadingProgress: null,
    })),
  setMetadata: (metadata) =>
    set({
      metadata,
      status: 'ready',
      error: null,
      loadingPhase: '元信息已就绪',
      loadingProgress: 100,
    }),
  setPreview: (preview) =>
    set({
      preview,
      previewStatus: preview ? 'ready' : 'idle',
    }),
  setPreviewStatus: (previewStatus) => set({ previewStatus }),
  setValidityMask: (validityMask) =>
    set({
      validityMask,
      validityStatus: validityMask ? 'ready' : 'idle',
    }),
  setValidityStatus: (validityStatus) => set({ validityStatus }),
  setStatus: (status) => set({ status }),
  setError: (error) =>
    set({
      error,
      status: 'error',
      loadingPhase: '读取失败',
      loadingProgress: null,
    }),
  setPointerText: (pointerText) => set({ pointerText }),
  setLoadingProgress: (loadingPhase, loadingProgress) =>
    set({
      loadingPhase,
      loadingProgress,
      status: 'loading',
    }),
  reset: () => set(INITIAL_STATE),
}));
