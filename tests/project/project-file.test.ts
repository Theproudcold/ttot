import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  PROJECT_FILE_EXTENSION,
  buildProjectFileName,
  downloadProjectFile,
  readProjectFile,
} from '@/features/project/projectFile';
import {
  exportProjectSnapshot,
  serializeProjectSnapshot,
  type ExportProjectSnapshotInput,
} from '@/features/project/projectSnapshot';

function makeSnapshot(overrides: Partial<ExportProjectSnapshotInput> = {}) {
  return exportProjectSnapshot({
    sourceFile: null,
    sourceLabel: '未选择文件',
    metadata: null,
    fenceRings: [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
    ],
    grid: { cellSize: 2, rotation: 15, aggregationMode: 'max' },
    classification: { layers: [], activeLayerId: null, visibleLayerId: null },
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

describe('buildProjectFileName', () => {
  it('derives the name from the raster file name', () => {
    expect(buildProjectFileName('test2.tif')).toBe(`test2-project${PROJECT_FILE_EXTENSION}`);
    expect(buildProjectFileName('field-01.tiff')).toBe(`field-01-project${PROJECT_FILE_EXTENSION}`);
    expect(buildProjectFileName('scan')).toBe(`scan-project${PROJECT_FILE_EXTENSION}`);
  });

  it('falls back to a neutral name when there is no usable source label', () => {
    expect(buildProjectFileName(null)).toBe(`ttot-project${PROJECT_FILE_EXTENSION}`);
    expect(buildProjectFileName('   ')).toBe(`ttot-project${PROJECT_FILE_EXTENSION}`);
    expect(buildProjectFileName('未选择文件')).toBe(`ttot-project${PROJECT_FILE_EXTENSION}`);
  });

  it('strips characters that break file names', () => {
    expect(buildProjectFileName('a/b\\c:d.tif')).toBe(`a-b-c-d-project${PROJECT_FILE_EXTENSION}`);
  });
});

describe('downloadProjectFile', () => {
  const createObjectURL = vi.fn(() => 'blob:project');
  const revokeObjectURL = vi.fn();

  beforeAll(() => {
    // jsdom 不一定实现 Blob URL API，这里显式打桩
    Object.assign(URL, { createObjectURL, revokeObjectURL });
  });

  afterAll(() => {
    createObjectURL.mockReset();
    revokeObjectURL.mockReset();
  });

  it('downloads the serialized snapshot and reports the file name', () => {
    const snapshot = makeSnapshot();
    const click = vi.fn();
    const createElement = document.createElement.bind(document);

    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      const element = createElement(tagName);

      if (tagName === 'a') {
        (element as HTMLAnchorElement).click = click;
      }

      return element;
    });

    const filename = downloadProjectFile(snapshot, 'my-project.ttot.json');

    expect(filename).toBe('my-project.ttot.json');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:project');

    vi.restoreAllMocks();
  });
});

describe('readProjectFile', () => {
  it('parses a saved project file', async () => {
    const snapshot = makeSnapshot();
    const result = await readProjectFile(new Blob([serializeProjectSnapshot(snapshot)]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot).toEqual(snapshot);
  });

  it('rejects content that is not a project file', async () => {
    const result = await readProjectFile(new Blob(['{ not json']));
    expect(result.ok).toBe(false);
  });

  it('rejects a taller-version project instead of guessing', async () => {
    const result = await readProjectFile(
      new Blob([JSON.stringify({ kind: 'ttot-project', version: 99 })]),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('v99');
  });

  it('round-trips through save and read', async () => {
    const snapshot = makeSnapshot();
    const text = serializeProjectSnapshot(snapshot);
    const result = await readProjectFile(new Blob([text]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.grid).toEqual({ cellSize: 2, rotation: 15, aggregationMode: 'max' });
    expect(result.snapshot.fence?.rings).toHaveLength(1);
  });
});
