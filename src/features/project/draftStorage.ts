/**
 * 工程草稿的本地持久化（localStorage）。
 *
 * 设计约束：
 * - 草稿内容与 `ProjectSnapshotV1` 同构，因此「草稿恢复」与「打开工程」走同一条还原链路。
 * - 影像本身无法序列化，草稿只保留指纹；恢复时不静默生效，一律交回上层做用户提示。
 * - 多标签页：写入前比对 tabId，不覆盖其它标签页的草稿（同标签页内后写覆盖前写）。
 * - 任何存储异常（配额、隐私模式）都降级为「不持久化」，不向上抛错。
 */

import type { ProjectSnapshotV1 } from './projectSnapshot';
import { validateProjectSnapshot } from './projectSnapshot';

export const DRAFT_STORAGE_KEY = 'ttot:draft:v1';
/** 超过该长度直接放弃写入，避免触发配额异常 */
export const DRAFT_MAX_BYTES = 1_000_000;
export const DRAFT_DEBOUNCE_MS = 1000;

export type DraftRecord = {
  tabId: string;
  savedAt: string;
  snapshot: ProjectSnapshotV1;
};

export type DraftWriteResult =
  | 'written'
  | 'skipped-oversize'
  | 'skipped-other-tab'
  | 'unavailable';

let cachedTabId: string | null = null;

/** 当前标签页标识；跨标签页互不覆盖的依据 */
export function getTabId(): string {
  if (cachedTabId) {
    return cachedTabId;
  }

  const cryptoObject = globalThis.crypto;

  cachedTabId =
    cryptoObject && typeof cryptoObject.randomUUID === 'function'
      ? cryptoObject.randomUUID()
      : `tab-${Math.random().toString(36).slice(2)}-${Date.now()}`;

  return cachedTabId;
}

function resolveStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) {
    return storage;
  }

  try {
    // 隐私模式下访问 localStorage 本身就可能抛错
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readRawRecord(storage: Storage): DraftRecord | null {
  let text: string | null = null;

  try {
    text = storage.getItem(DRAFT_STORAGE_KEY);
  } catch {
    return null;
  }

  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as DraftRecord).tabId !== 'string' ||
      typeof (parsed as DraftRecord).savedAt !== 'string'
    ) {
      return null;
    }

    return parsed as DraftRecord;
  } catch {
    return null;
  }
}

function hasRawValue(storage: Storage): boolean {
  try {
    return storage.getItem(DRAFT_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export function writeDraft(
  snapshot: ProjectSnapshotV1,
  options: { storage?: Storage | null; tabId?: string } = {},
): DraftWriteResult {
  const storage = resolveStorage(options.storage);
  if (!storage) {
    return 'unavailable';
  }

  const record: DraftRecord = {
    tabId: options.tabId ?? getTabId(),
    savedAt: new Date().toISOString(),
    snapshot,
  };

  let payload: string;
  try {
    payload = JSON.stringify(record);
  } catch {
    return 'unavailable';
  }

  if (payload.length > DRAFT_MAX_BYTES) {
    return 'skipped-oversize';
  }

  const existing = readRawRecord(storage);
  if (existing && existing.tabId !== record.tabId) {
    return 'skipped-other-tab';
  }

  try {
    storage.setItem(DRAFT_STORAGE_KEY, payload);
    return 'written';
  } catch {
    return 'unavailable';
  }
}

/**
 * 读取草稿。内容损坏或校验不通过时返回 null（并清理掉，避免每次启动都失败）。
 */
export function readDraft(
  options: { storage?: Storage | null } = {},
): (DraftRecord & { warnings: string[] }) | null {
  const storage = resolveStorage(options.storage);
  if (!storage) {
    return null;
  }

  const record = readRawRecord(storage);
  if (!record) {
    // 内容损坏（无法解析或结构不符）时直接清理，避免每次启动都重复失败
    if (hasRawValue(storage)) {
      clearDraft({ storage });
    }
    return null;
  }

  const parsed = validateProjectSnapshot(record.snapshot);
  if (!parsed.ok) {
    clearDraft({ storage });
    return null;
  }

  return { ...record, snapshot: parsed.snapshot, warnings: parsed.warnings };
}

export function clearDraft(options: { storage?: Storage | null } = {}): void {
  const storage = resolveStorage(options.storage);
  if (!storage) {
    return;
  }

  try {
    storage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // 清理失败不影响主流程
  }
}

export type DraftScheduler = {
  schedule: (snapshot: ProjectSnapshotV1) => void;
  flush: () => void;
  cancel: () => void;
};

/**
 * 带防抖的草稿写入器。计时器与存储均可注入，便于测试。
 */
export function createDraftScheduler(
  options: {
    delay?: number;
    storage?: Storage | null;
    tabId?: string;
    setTimeoutFn?: typeof setTimeout;
    clearTimeoutFn?: typeof clearTimeout;
    onResult?: (result: DraftWriteResult) => void;
  } = {},
): DraftScheduler {
  const delay = options.delay ?? DRAFT_DEBOUNCE_MS;
  const setTimer = options.setTimeoutFn ?? globalThis.setTimeout;
  const clearTimer = options.clearTimeoutFn ?? globalThis.clearTimeout;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: ProjectSnapshotV1 | null = null;

  const commit = (snapshot: ProjectSnapshotV1) => {
    const result = writeDraft(snapshot, { storage: options.storage, tabId: options.tabId });
    options.onResult?.(result);
  };

  const stopTimer = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  return {
    schedule(snapshot) {
      pending = snapshot;
      stopTimer();
      timer = setTimer(() => {
        timer = null;
        const next = pending;
        pending = null;
        if (next) {
          commit(next);
        }
      }, delay);
    },
    flush() {
      stopTimer();
      const next = pending;
      pending = null;
      if (next) {
        commit(next);
      }
    },
    cancel() {
      stopTimer();
      pending = null;
    },
  };
}
