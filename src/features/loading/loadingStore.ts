import { create } from 'zustand';

type LoadingState = {
  /** 当前是否正在加载 */
  active: boolean;
  /** 加载提示文本 */
  message: string;
  /** 开始加载 */
  start: (message?: string) => void;
  /** 更新提示文本 */
  update: (message: string) => void;
  /** 结束加载 */
  stop: () => void;
};

export const useLoadingStore = create<LoadingState>((set) => ({
  active: false,
  message: '',
  start: (message = '处理中...') => set({ active: true, message }),
  update: (message) => set({ message }),
  stop: () => set({ active: false, message: '' }),
}));
