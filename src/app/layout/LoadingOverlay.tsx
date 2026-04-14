import { useLoadingStore } from '@/features/loading/loadingStore';

export function LoadingOverlay() {
  const active = useLoadingStore((state) => state.active);
  const message = useLoadingStore((state) => state.message);

  if (!active) {
    return null;
  }

  return (
    <div className="loading-overlay" aria-live="assertive">
      <div className="loading-overlay__card">
        <div className="loading-overlay__spinner" />
        <span className="loading-overlay__text">{message}</span>
      </div>
    </div>
  );
}
