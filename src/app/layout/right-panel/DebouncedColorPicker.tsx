import { useEffect, useState } from 'react';

/**
 * 带防抖的颜色选择器。
 * 本地状态实时响应输入，但只有在停止操作 300ms 后才触发 onChange。
 */
export function DebouncedColorPicker({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (val: string) => void;
  className?: string;
}) {
  const [localColor, setLocalColor] = useState(value);

  useEffect(() => {
    setLocalColor(value);
  }, [value]);

  useEffect(() => {
    const handler = setTimeout(() => {
      if (localColor !== value) {
        onChange(localColor);
      }
    }, 300);
    return () => clearTimeout(handler);
  }, [localColor, value, onChange]);

  return (
    <input
      type="color"
      className={className}
      value={localColor}
      onChange={(e) => setLocalColor(e.target.value)}
    />
  );
}
