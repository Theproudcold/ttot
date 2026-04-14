import { useFenceStore } from '@/features/fence/fenceStore';
import { useGridStore } from '@/features/grid/gridStore';

export function AlertOverlay() {
  const validationMessage = useFenceStore((state) => state.validationMessage);
  const gridSummary = useGridStore((state) => state.summary);
  const warnings = [validationMessage, gridSummary?.warning].filter(
    (value): value is string => Boolean(value),
  );

  if (warnings.length === 0) {
    return null;
  }

  return (
    <div className="alert-overlay">
      {warnings.map((warning, index) => (
        <div key={`${warning}-${index}`} className="alert-toast">
          <span className="alert-toast__icon">⚠️</span>
          <span className="alert-toast__text">{warning}</span>
        </div>
      ))}
    </div>
  );
}
