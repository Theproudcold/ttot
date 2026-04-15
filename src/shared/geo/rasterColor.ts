/**
 * 栅格颜色处理工具模块。
 * 提供十六进制与 RGB/RGBA 的互相转换、颜色插值、以及像元值归一化到字节范围的工具函数。
 */

/**
 * 将十六进制颜色字符串转换为 RGB 三元组 [r, g, b]。
 * 支持简写格式（如 #f0a）和完整格式（如 #ff00aa）。
 */
export function hexToRgb(color: string): [number, number, number] {
  const normalized = color.trim().replace('#', '');
  const hex =
    normalized.length === 3
      ? normalized
          .split('')
          .map((value) => `${value}${value}`)
          .join('')
      : normalized;

  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

/**
 * 将十六进制颜色字符串转换为 RGBA 四元组 [r, g, b, a]。
 * 支持 #RGBA（4位）、#RRGGBBAA（8位）和 #RRGGBB（6位，默认不透明）。
 */
export function hexToRgba(color: string): [number, number, number, number] {
  const normalized = color.trim().replace('#', '');

  if (normalized.length === 4) {
    const [red, green, blue, alpha] = normalized.split('');
    return [
      Number.parseInt(`${red}${red}`, 16),
      Number.parseInt(`${green}${green}`, 16),
      Number.parseInt(`${blue}${blue}`, 16),
      Number.parseInt(`${alpha}${alpha}`, 16),
    ];
  }

  if (normalized.length === 8) {
    return [
      Number.parseInt(normalized.slice(0, 2), 16),
      Number.parseInt(normalized.slice(2, 4), 16),
      Number.parseInt(normalized.slice(4, 6), 16),
      Number.parseInt(normalized.slice(6, 8), 16),
    ];
  }

  const [red, green, blue] = hexToRgb(color);
  return [red, green, blue, 255];
}

/**
 * 将 RGB 三个分量转换为十六进制颜色字符串 #RRGGBB。
 */
export function rgbToHex(red: number, green: number, blue: number): string {
  const toHex = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

/**
 * 在两个十六进制颜色之间按 ratio 进行线性插值。
 * ratio 为 0 时返回 startColor，为 1 时返回 endColor。
 */
export function interpolateHexColors(startColor: string, endColor: string, ratio: number): string {
  const [startRed, startGreen, startBlue] = hexToRgb(startColor);
  const [endRed, endGreen, endBlue] = hexToRgb(endColor);
  const clampedRatio = Math.max(0, Math.min(1, ratio));

  return rgbToHex(
    startRed + (endRed - startRed) * clampedRatio,
    startGreen + (endGreen - startGreen) * clampedRatio,
    startBlue + (endBlue - startBlue) * clampedRatio,
  );
}

/**
 * 将数值按 [min, max] 范围归一化到 [0, 255] 字节范围。
 * 超出范围将被截断，非有限值返回 0。
 */
export function normalizeToByte(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const normalized = ((value - min) / (max - min)) * 255;
  return Math.max(0, Math.min(255, Math.round(normalized)));
}
