import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DRAFT_MAX_BYTES,
  DRAFT_STORAGE_KEY,
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

  it('does not overwrite a draft owned by another tab', () => {
    writeDraft(makeSnapshot(), { storage, tabId: 'tab-1' });

    expect(writeDraft(makeSnapshot(), { storage, tabId: 'tab-2' })).toBe('skipped-other-tab');
    expect(readDraft({ storage })?.tabId).toBe('tab-1');
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
