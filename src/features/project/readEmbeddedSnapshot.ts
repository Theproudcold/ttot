/**
 * 从影像文件中读取内嵌的工程配方。
 *
 * 复用 `openRasterSession` 的会话缓存：若该文件此前已为解析元信息而打开过，
 * 这里不会产生额外的一次全量读取。
 */

import { openRasterSession } from '@/shared/geo/rasterIo';

import { decodeEmbeddedSnapshot, type SnapshotParseResult } from './projectSnapshot';

/**
 * 读取 ImageDescription（tag 270）中的工程配方。
 *
 * 返回 null 表示该文件没有本工具的内嵌配方（例如第三方 GeoTIFF，
 * 或 ImageDescription 里写的是 GDAL 版本号之类），调用方应继续走普通影像流程。
 */
export async function readEmbeddedProjectSnapshot(
  file: File,
): Promise<SnapshotParseResult | null> {
  const image = await openRasterSession(file).getImage();
  const fileDirectory = (image.getFileDirectory?.() ?? {}) as Record<string, unknown>;
  const description =
    typeof fileDirectory.ImageDescription === 'string' ? fileDirectory.ImageDescription : null;

  return decodeEmbeddedSnapshot(description);
}
