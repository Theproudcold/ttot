/**
 * 工程草稿的本地持久化（localStorage）。
 *
 * 设计约束：
 * - 草稿内容与 `ProjectSnapshotV1` 同构，因此「草稿恢复」与「打开工程」走同一条还原链路。
 * - 影像本身无法序列化，草稿只保留指纹；恢复时不静默生效，一律交回上层做用户提示。
 * - 多标签页：**每个标签页各存一份**，互不覆盖；读取时取最新的一份。
 *   （早期实现用"单槽 + tabId 互斥"，结果是后开的标签页永远写不进去，工作静默丢失。）
 * - 任何存储异常（配额、隐私模式）都降级为「不持久化」，不向上抛错。
 */

import type { ProjectSnapshotV1 } from './projectSnapshot';
import { validateProjectSnapshot } from './projectSnapshot';

export const DRAFT_STORAGE_KEY = 'ttot:draft:v1';
/** 超过该字节数直接放弃写入，避免触发配额异常 */
export const DRAFT_MAX_BYTES = 1_000_000;
export const DRAFT_DEBOUNCE_MS = 1000;
/** 最多保留的标签页草稿份数，超出时丢弃最旧的 */
export const MAX_DRAFT_ENTRIES = 5;

export type DraftRecord = {
  tabId: string;
  savedAt: string;
  snapshot: ProjectSnapshotV1;
};

export type DraftWriteResult = 'written' | 'skipped-oversize' | 'unavailable';

/** 存储容器：每个标签页一条记录 */
type DraftStoreShape = {
  version: 1;
  drafts: Record<string, DraftRecord>;
};

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

function isDraftRecord(value: unknown): value is DraftRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as DraftRecord).tabId === 'string' &&
    typeof (value as DraftRecord).savedAt === 'string' &&
    typeof (value as DraftRecord).snapshot === 'object' &&
    (value as DraftRecord).snapshot !== null
  );
}

/**
 * 读取草稿容器。
 * 兼容早期"单条记录直接放在 key 上"的存储形态，避免升级后旧草稿读不出来。
 */
function readDraftStore(storage: Storage): DraftStoreShape | null {
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

    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const container = parsed as { drafts?: unknown };

    if (container.drafts && typeof container.drafts === 'object') {
      const drafts: Record<string, DraftRecord> = {};

      for (const [key, value] of Object.entries(container.drafts as Record<string, unknown>)) {
        if (isDraftRecord(value)) {
          drafts[key] = value;
        }
      }

      return { version: 1, drafts };
    }

    if (isDraftRecord(parsed)) {
      return { version: 1, drafts: { [(parsed as DraftRecord).tabId]: parsed as DraftRecord } };
    }

    return null;
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

/** 只保留最近写入的若干份，避免标签页反复开关导致无限增长 */
function pruneDrafts(store: DraftStoreShape): void {
  const entries = Object.entries(store.drafts);

  if (entries.length <= MAX_DRAFT_ENTRIES) {
    return;
  }

  entries
    .sort(([, a], [, b]) => (a.savedAt < b.savedAt ? 1 : -1))
    .slice(MAX_DRAFT_ENTRIES)
    .forEach(([key]) => {
      delete store.drafts[key];
    });
}

function persistDraftStore(storage: Storage, store: DraftStoreShape): DraftWriteResult {
  if (Object.keys(store.drafts).length === 0) {
    try {
      storage.removeItem(DRAFT_STORAGE_KEY);
      return 'written';
    } catch {
      return 'unavailable';
    }
  }

  let payload: string;
  try {
    payload = JSON.stringify(store);
  } catch {
    return 'unavailable';
  }

  // localStorage 的配额按字节计，而 String.length 是 UTF-16 码元数：
  // 中文/emoji 内容会在「码元数没超」的情况下先撞上配额。
  if (new TextEncoder().encode(payload).byteLength > DRAFT_MAX_BYTES) {
    return 'skipped-oversize';
  }

  try {
    storage.setItem(DRAFT_STORAGE_KEY, payload);
    return 'written';
  } catch {
    return 'unavailable';
  }
}

/**
 * 写入当前标签页的草稿。每个标签页各占一条，因此不会覆盖其它标签页。
 */
export function writeDraft(
  snapshot: ProjectSnapshotV1,
  options: { storage?: Storage | null; tabId?: string; savedAt?: string } = {},
): DraftWriteResult {
  const storage = resolveStorage(options.storage);
  if (!storage) {
    return 'unavailable';
  }

  const record: DraftRecord = {
    tabId: options.tabId ?? getTabId(),
    savedAt: options.savedAt ?? new Date().toISOString(),
    snapshot,
  };

  const store = readDraftStore(storage) ?? { version: 1, drafts: {} };
  store.drafts[record.tabId] = record;
  pruneDrafts(store);

  return persistDraftStore(storage, store);
}

/**
 * 读取草稿：默认取最新的一份（多标签页场景下最近干过活的那个）。
 * 指定 tabId 时只读该标签页自己的草稿。
 *
 * 内容损坏或校验不通过时返回 null，并只清理该条记录，不影响其它标签页。
 */
export function readDraft(
  options: { storage?: Storage | null; tabId?: string } = {},
): (DraftRecord & { warnings: string[] }) | null {
  const storage = resolveStorage(options.storage);
  if (!storage) {
    return null;
  }

  const store = readDraftStore(storage);
  if (!store) {
    // 整个容器都无法解析时清理掉，避免每次启动都重复失败
    if (hasRawValue(storage)) {
      clearDraft({ storage });
    }
    return null;
  }

  const record = options.tabId
    ? store.drafts[options.tabId]
    : Object.values(store.drafts).sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))[0];

  if (!record) {
    return null;
  }

  const parsed = validateProjectSnapshot(record.snapshot);
  if (!parsed.ok) {
    delete store.drafts[record.tabId];
    persistDraftStore(storage, store);
    return null;
  }

  return { ...record, snapshot: parsed.snapshot, warnings: parsed.warnings };
}

/**
 * 清理草稿。不传 tabId 时清空全部（对应界面上"忽略"的语义）；
 * 传 tabId 时只清掉该标签页的那一条。
 */
export function clearDraft(options: { storage?: Storage | null; tabId?: string } = {}): void {
  const storage = resolveStorage(options.storage);
  if (!storage) {
    return;
  }

  if (!options.tabId) {
    try {
      storage.removeItem(DRAFT_STORAGE_KEY);
    } catch {
      // 清理失败不影响主流程
    }
    return;
  }

  const store = readDraftStore(storage);
  if (!store) {
    return;
  }

  delete store.drafts[options.tabId];
  persistDraftStore(storage, store);
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
