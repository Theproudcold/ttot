import { useEffect, useState } from 'react';

import { useDebounce } from '@/shared/hooks/useDebounce';

/**
 * 分类方案名称输入框。
 * 本地编辑与防抖同步，避免频繁更新全局状态。
 */
export function ClassificationLayerNameInput({
  layerId,
  label,
  onChange,
}: {
  layerId: string;
  label: string;
  onChange: (id: string, updates: { label: string }) => void;
}) {
  const [localLabel, setLocalLabel] = useState(label);
  const debouncedLabel = useDebounce(localLabel, 300);

  useEffect(() => {
    setLocalLabel(label);
  }, [label]);

  useEffect(() => {
    if (debouncedLabel !== label) {
      onChange(layerId, { label: debouncedLabel });
    }
  }, [debouncedLabel, label, layerId, onChange]);

  return (
    <input
      id="classification-layer-name"
      className="field-input"
      type="text"
      value={localLabel}
      onChange={(event) => setLocalLabel(event.target.value)}
    />
  );
}
