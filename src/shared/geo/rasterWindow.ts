import type { FenceBoundingBox } from '@/shared/types/fence';
import type { PixelWindow, RasterOrigin, RasterResolution } from '@/shared/types/raster';

/**
 * 影像在自身 CRS 下的外接范围。
 * 行列增长方向由 resolution 的符号决定，因此两端取 min/max 后再排序。
 */
export function getRasterExtent(
  rasterWidth: number,
  rasterHeight: number,
  origin: RasterOrigin,
  resolution: RasterResolution,
): FenceBoundingBox {
  const [originX, originY] = origin;
  const [resolutionX, resolutionY] = resolution;
  const maxX = originX + rasterWidth * resolutionX;
  const minY = originY + rasterHeight * resolutionY;

  return [
    Math.min(originX, maxX),
    Math.min(originY, minY),
    Math.max(originX, maxX),
    Math.max(originY, minY),
  ];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 把围栏外接框换算成需要读取的像素窗口。
 * 返回的窗口已裁剪到影像范围内，可直接交给 geotiff.js 的 readRasters。
 */
export function getPixelWindowFromFenceBoundingBox(input: {
  bbox: FenceBoundingBox;
  rasterWidth: number;
  rasterHeight: number;
  origin: RasterOrigin;
  resolution: RasterResolution;
}): PixelWindow {
  const { bbox, rasterWidth, rasterHeight, origin, resolution } = input;
  const [minX, minY, maxX, maxY] = bbox;
  const [originX, originY] = origin;
  const [resolutionX, resolutionY] = resolution;
  const [rasterMinX, rasterMinY, rasterMaxX, rasterMaxY] = getRasterExtent(
    rasterWidth,
    rasterHeight,
    origin,
    resolution,
  );

  if (maxX <= rasterMinX || minX >= rasterMaxX || maxY <= rasterMinY || minY >= rasterMaxY) {
    throw new Error('围栏超出影像范围');
  }

  const safeResolutionX = resolutionX || Number.EPSILON;
  const safeResolutionY = resolutionY || -Number.EPSILON;

  // 行列增长方向由 resolution 的符号决定（常见为 north-up，即 resolutionY < 0）。
  // 先算出边界对应的两端坐标再排序，避免对 south-up 栅格推导出退化的窗口。
  const colA = (minX - originX) / safeResolutionX;
  const colB = (maxX - originX) / safeResolutionX;
  const rowA = (maxY - originY) / safeResolutionY;
  const rowB = (minY - originY) / safeResolutionY;

  const startCol = clamp(Math.floor(Math.min(colA, colB)), 0, rasterWidth - 1);
  const endCol = clamp(Math.ceil(Math.max(colA, colB)), 1, rasterWidth);
  const startRow = clamp(Math.floor(Math.min(rowA, rowB)), 0, rasterHeight - 1);
  const endRow = clamp(Math.ceil(Math.max(rowA, rowB)), 1, rasterHeight);

  return [Math.min(startCol, endCol - 1), Math.min(startRow, endRow - 1), endCol, endRow];
}
