import { useEffect, useState } from 'react';

import { useDebounce } from '@/shared/hooks/useDebounce';

/**
 * 分类规则标签输入框。
 * 本地编辑与防抖同步，避免频繁更新全局状态。
 */
export function RuleLabelInput({
  ruleIndex,
  label,
  onChange,
}: {
  ruleIndex: number;
  label: string;
  onChange: (index: number, field: 'label', value: string) => void;
}) {
  const [localLabel, setLocalLabel] = useState(label);
  const debouncedLabel = useDebounce(localLabel, 300);

  useEffect(() => {
    setLocalLabel(label);
  }, [label]);

  useEffect(() => {
    if (debouncedLabel !== label) {
      onChange(ruleIndex, 'label', debouncedLabel);
    }
  }, [debouncedLabel, label, ruleIndex, onChange]);

  return (
    <input
      className="field-input"
      type="text"
      value={localLabel}
      onChange={(event) => setLocalLabel(event.target.value)}
    />
  );
}
