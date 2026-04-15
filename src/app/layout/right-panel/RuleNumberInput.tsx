import { useEffect, useState } from 'react';

import { useDebouncedCallback } from '@/shared/hooks/useDebouncedCallback';

/**
 * 带防抖的数字输入框。
 * 支持空值（转为 null），并在外部值真正变化时才同步本地输入，
 * 避免打断用户正在输入的小数点或尾留 0。
 */
export function RuleNumberInput({
  value,
  onChange,
  className,
  placeholder,
  step,
  debounceMs = 300,
}: {
  value: number | null | undefined;
  onChange: (val: number | null) => void;
  className?: string;
  placeholder?: string;
  step?: string;
  debounceMs?: number;
}) {
  const [localValue, setLocalValue] = useState(value == null ? '' : String(value));
  const debouncedOnChange = useDebouncedCallback(onChange, debounceMs);

  useEffect(() => {
    if (value == null) {
      if (localValue !== '') setLocalValue('');
      return;
    }
    const currentParsed = Number(localValue);
    // 只在外部赋的值真正改变时才同步更新本地输入内容，保护用户输入中的小数点或者尾留0
    if (!Number.isFinite(currentParsed) || currentParsed !== value) {
      setLocalValue(String(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      type="number"
      className={className}
      placeholder={placeholder}
      step={step}
      value={localValue}
      onChange={(e) => {
        setLocalValue(e.target.value);
        if (e.target.value === '') {
          debouncedOnChange(null);
          return;
        }
        const nextValue = Number(e.target.value);
        if (Number.isFinite(nextValue)) {
          debouncedOnChange(nextValue);
        }
      }}
    />
  );
}
