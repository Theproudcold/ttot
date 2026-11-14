/**
 * 从影像文件中读取内嵌的工程配方。
 *
 * 两条路径：
 * 1. 优先交给 Worker —— 主线程不必为读一个 ASCII tag 而常驻一份整文件缓冲；
 * 2. 取不到 Worker 时在主线程读取，并复用按内容指纹键控的解析会话。
 */

import { buildRasterSourceKey, openRasterSession } from '@/shared/geo/rasterIo';
import {
  createRasterWorkerJobId,
  getRasterWorker,
  requestRasterWorker,
} from '@/shared/workers/rasterWorkerRegistry';

import { decodeEmbeddedSnapshot, type SnapshotParseResult } from './projectSnapshot';

/**
 * 读取 ImageDescription（tag 270）中的工程配方。
 *
 * 返回 null 表示该文件没有本工具的内嵌配方（例如第三方 GeoTIFF，
 * 或 ImageDescription 里写的是 GDAL 版本号之类），调用方应继续走普通影像流程。
 */
export async function readEmbeddedProjectSnapshotWithSession(
  file: File,
): Promise<SnapshotParseResult | null> {
  const image = await openRasterSession(file, { cacheKey: buildRasterSourceKey(file) }).getImage();
  const fileDirectory = (image.getFileDirectory?.() ?? {}) as Record<string, unknown>;
  const description =
    typeof fileDirectory.ImageDescription === 'string' ? fileDirectory.ImageDescription : null;

  return decodeEmbeddedSnapshot(description);
}

export async function readEmbeddedProjectSnapshot(
  file: File,
): Promise<SnapshotParseResult | null> {
  const worker = getRasterWorker();

  if (worker) {
    try {
      const response = await requestRasterWorker<'read-embedded-snapshot'>(worker, {
        id: createRasterWorkerJobId(),
        type: 'read-embedded-snapshot',
        payload: { source: file, sourceKey: buildRasterSourceKey(file) },
      });

      return response.result;
    } catch {
      // 落到主线程读取，行为与没有 Worker 时一致
    }
  }

  return await readEmbeddedProjectSnapshotWithSession(file);
}
