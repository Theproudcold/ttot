import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DRAFT_MAX_BYTES,
  DRAFT_STORAGE_KEY,
  MAX_DRAFT_ENTRIES,
  clearDraft,
  createDraftScheduler,
  getTabId,
  readDraft,
  writeDraft,
} from '@/features/project/draftStorage';
import {
  exportProjectSnapshot,
  type ExportProjectSnapshotInput,
} from '@/features/project/projectSnapshot';

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();

  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

function makeSnapshot(overrides: Partial<ExportProjectSnapshotInput> = {}) {
  return exportProjectSnapshot({
    sourceFile: null,
    sourceLabel: '未选择文件',
    metadata: null,
    fenceRings: [
      [
        [0, 0],
        [5, 0],
        [5, 5],
        [0, 5],
        [0, 0],
      ],
    ],
    grid: { cellSize: 1, rotation: 0, aggregationMode: 'mean' },
    classification: {
      layers: [
        {
          id: 'rules-a',
          label: '规则方案',
          noDataColor: '#00000000',
          visible: true,
          mode: 'rules',
          gradientStops: [],
          rules: [{ min: 0, max: null, color: '#226622', label: '高值', applicationRate: null }],
        },
      ],
      activeLayerId: 'rules-a',
      visibleLayerId: 'rules-a',
    },
    view: {
      layers: { raster: true, fence: true, grid: true },
      gridRenderSettings: {
        useClassificationColors: true,
        fillColor: '#3388ff',
        fillOpacity: 0.3,
        strokeColor: '#3388ff',
        strokeOpacity: 0.8,
        strokeWidth: 1,
      },
    },
    ...overrides,
  });
}

let storage: Storage;

beforeEach(() => {
  storage = createMemoryStorage();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getTabId', () => {
  it('returns a stable identifier', () => {
    expect(getTabId()).toBe(getTabId());
    expect(getTabId().length).toBeGreaterThan(0);
  });
});

describe('writeDraft / readDraft', () => {
  it('round-trips a snapshot through local storage', () => {
    const snapshot = makeSnapshot();

    expect(writeDraft(snapshot, { storage, tabId: 'tab-1' })).toBe('written');

    const restored = readDraft({ storage });
    expect(restored?.tabId).toBe('tab-1');
    expect(restored?.snapshot).toEqual(snapshot);
  });

  it('keeps a separate draft per tab instead of letting one tab block another', () => {
    // 早期实现用"单槽 + tabId 互斥"，后开的标签页会永远写不进去、工作静默丢失
    expect(
      writeDraft(makeSnapshot(), {
        storage,
        tabId: 'tab-1',
        savedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBe('written');
    expect(
      writeDraft(makeSnapshot({ grid: { cellSize: 7, rotation: 0, aggregationMode: 'max' } }), {
        storage,
        tabId: 'tab-2',
        savedAt: '2026-01-02T00:00:00.000Z',
      }),
    ).toBe('written');

    // 默认读最新的一份
    expect(readDraft({ storage })?.tabId).toBe('tab-2');
    // 指定 tabId 时各读各的
    expect(readDraft({ storage, tabId: 'tab-1' })?.snapshot.grid.cellSize).toBe(1);
    expect(readDraft({ storage, tabId: 'tab-2' })?.snapshot.grid.cellSize).toBe(7);
  });

  it('prunes the oldest entries once too many tabs have written', () => {
    for (let index = 0; index < MAX_DRAFT_ENTRIES + 2; index += 1) {
      writeDraft(makeSnapshot(), {
        storage,
        tabId: `tab-${index}`,
        savedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
      });
    }

    expect(readDraft({ storage, tabId: 'tab-0' })).toBeNull();
    expect(readDraft({ storage, tabId: `tab-${MAX_DRAFT_ENTRIES + 1}` })).not.toBeNull();
  });

  it('reads a legacy single-record draft written by an older version', () => {
    storage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({
        tabId: 'legacy-tab',
        savedAt: '2026-01-01T00:00:00.000Z',
        snapshot: makeSnapshot(),
      }),
    );

    expect(readDraft({ storage })?.tabId).toBe('legacy-tab');
    expect(readDraft({ storage, tabId: 'legacy-tab' })?.tabId).toBe('legacy-tab');
  });

  it('clears only the requested tab when a tabId is given', () => {
    writeDraft(makeSnapshot(), { storage, tabId: 'tab-1' });
    writeDraft(makeSnapshot(), { storage, tabId: 'tab-2' });

    clearDraft({ storage, tabId: 'tab-1' });

    expect(readDraft({ storage, tabId: 'tab-1' })).toBeNull();
    expect(readDraft({ storage, tabId: 'tab-2' })).not.toBeNull();
  });

  it('lets the same tab overwrite its own draft', () => {
    writeDraft(makeSnapshot({ grid: { cellSize: 1, rotation: 0, aggregationMode: 'mean' } }), {
      storage,
      tabId: 'tab-1',
    });
    writeDraft(makeSnapshot({ grid: { cellSize: 9, rotation: 0, aggregationMode: 'max' } }), {
      storage,
      tabId: 'tab-1',
    });

    expect(readDraft({ storage })?.snapshot.grid.cellSize).toBe(9);
  });

  it('skips oversized payloads instead of risking a quota error', () => {
    const snapshot = makeSnapshot();
    // 让序列化结果超过上限
    (snapshot as { padding?: string }).padding = 'x'.repeat(DRAFT_MAX_BYTES);

    expect(writeDraft(snapshot, { storage, tabId: 'tab-1' })).toBe('skipped-oversize');
    expect(storage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  });

  it('measures the size budget in bytes rather than UTF-16 code units', () => {
    const snapshot = makeSnapshot();
    // 每字 3 字节：码元数只有上限的一半，UTF-8 字节数却已超出
    (snapshot as { padding?: string }).padding = '中'.repeat(DRAFT_MAX_BYTES / 3 + 1);

    expect(writeDraft(snapshot, { storage, tabId: 'tab-1' })).toBe('skipped-oversize');
  });

  it('degrades gracefully when storage throws', () => {
    const throwingStorage: Storage = {
      ...createMemoryStorage(),
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota exceeded');
      },
    };

    expect(writeDraft(makeSnapshot(), { storage: throwingStorage, tabId: 'tab-1' })).toBe('unavailable');
    expect(readDraft({ storage: throwingStorage })).toBeNull();
    expect(() => clearDraft({ storage: throwingStorage })).not.toThrow();
  });

  it('drops and clears a corrupted draft', () => {
    storage.setItem(DRAFT_STORAGE_KEY, '{ not json');

    expect(readDraft({ storage })).toBeNull();
    expect(storage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  });

  it('drops a draft whose snapshot fails validation', () => {
    storage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({ tabId: 'tab-1', savedAt: 'now', snapshot: { kind: 'other', version: 1 } }),
    );

    expect(readDraft({ storage })).toBeNull();
    expect(storage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  });

  it('writes nothing when storage is unavailable', () => {
    expect(writeDraft(makeSnapshot(), { storage: null })).toBe('unavailable');
    expect(readDraft({ storage: null })).toBeNull();
  });
});

describe('createDraftScheduler', () => {
  it('debounces writes and only persists the latest snapshot', () => {
    vi.useFakeTimers();
    const onResult = vi.fn();

    const scheduler = createDraftScheduler({ delay: 500, storage, tabId: 'tab-1', onResult });

    scheduler.schedule(makeSnapshot({ grid: { cellSize: 1, rotation: 0, aggregationMode: 'mean' } }));
    scheduler.schedule(makeSnapshot({ grid: { cellSize: 2, rotation: 0, aggregationMode: 'mean' } }));
    scheduler.schedule(makeSnapshot({ grid: { cellSize: 3, rotation: 0, aggregationMode: 'max' } }));

    expect(onResult).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith('written');
    expect(readDraft({ storage })?.snapshot.grid.cellSize).toBe(3);
  });

  it('flushes immediately (used before unload)', () => {
    vi.useFakeTimers();
    const scheduler = createDraftScheduler({ delay: 500, storage, tabId: 'tab-1' });

    scheduler.schedule(makeSnapshot({ grid: { cellSize: 7, rotation: 0, aggregationMode: 'min' } }));
    scheduler.flush();

    expect(readDraft({ storage })?.snapshot.grid.cellSize).toBe(7);

    vi.advanceTimersByTime(1000);
    expect(readDraft({ storage })?.snapshot.grid.cellSize).toBe(7);
  });

  it('cancel discards the pending write', () => {
    vi.useFakeTimers();
    const scheduler = createDraftScheduler({ delay: 500, storage, tabId: 'tab-1' });

    scheduler.schedule(makeSnapshot());
    scheduler.cancel();
    vi.advanceTimersByTime(2000);

    expect(storage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  });
});
