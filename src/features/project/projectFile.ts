/**
 * 工程文件（`.ttot.json`）的读写。
 *
 * 与另外两条持久化路径的分工：
 * - **草稿**（localStorage）：自动、被动，换浏览器/清缓存就没了；
 * - **内嵌配方**（GeoTIFF 的 ImageDescription / GeoJSON 的 `ttot:project`）：跟着产物走，
 *   但前提是你先导出了数据；
 * - **工程文件**：显式保存、可命名、可归档与分享，且不依赖任何导出产物。
 *
 * 内容就是 `ProjectSnapshotV1`，因此打开工程与「草稿恢复 / 内嵌还原」共用同一套
 * 校验与还原链路（`parseProjectSnapshot` → `buildRestorePlan` → `applyProjectSnapshot`）。
 */

import { readBlobBuffer } from '@/shared/geo/rasterIo';

import {
  parseProjectSnapshot,
  serializeProjectSnapshot,
  type ProjectSnapshotV1,
  type SnapshotParseResult,
} from './projectSnapshot';

export const PROJECT_FILE_EXTENSION = '.ttot.json';
const PROJECT_FILE_MIME = 'application/json';

/** 工程文件名：以影像名为前缀，便于成对归档 */
export function buildProjectFileName(sourceLabel: string | null | undefined): string {
  const raw = (sourceLabel ?? '').trim();
  const withoutExtension = raw.replace(/\.tiff?$/i, '');
  const base = withoutExtension.length > 0 && withoutExtension !== '未选择文件' ? withoutExtension : 'ttot';

  // 去掉路径分隔符与Windows/Unix 都不接受的字符，避免下载时被浏览器改名
  const safe = base.replace(/[\\/:*?"<>|]/g, '-');

  return `${safe}-project${PROJECT_FILE_EXTENSION}`;
}

/**
 * 下载工程文件。
 * @returns 实际使用的文件名（便于界面回显）
 */
export function downloadProjectFile(
  snapshot: ProjectSnapshotV1,
  filename?: string,
): string {
  const name =
    filename ??
    buildProjectFileName(
      snapshot.source?.sourceLabel ?? snapshot.source?.fingerprint.fileName ?? null,
    );

  const blob = new Blob([serializeProjectSnapshot(snapshot)], { type: PROJECT_FILE_MIME });
  const url = URL.createObjectURL(blob);

  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }

  return name;
}

/**
 * 读取工程文件。
 * 不用 `Blob.text()`：部分环境（含 jsdom）没有实现，统一走既有的 FileReader 封装。
 */
export async function readProjectFile(file: Blob): Promise<SnapshotParseResult> {
  let text: string;

  try {
    text = new TextDecoder().decode(await readBlobBuffer(file));
  } catch {
    return { ok: false, errors: ['无法读取工程文件内容'] };
  }

  return parseProjectSnapshot(text);
}
