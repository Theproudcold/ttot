import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fromArrayBufferMock } = vi.hoisted(() => ({
  fromArrayBufferMock: vi.fn(),
}));

vi.mock('geotiff', () => ({
  fromArrayBuffer: fromArrayBufferMock,
}));

import {
  buildRasterSourceKey,
  openRasterSession,
  resetRasterSessionCache,
} from '@/shared/geo/rasterIo';

function makeFile(name: string, lastModified = 1_700_000_000_000): File {
  const file = new File([new Uint8Array([1, 2, 3])], name, { type: 'image/tiff' });
  Object.defineProperty(file, 'lastModified', { value: lastModified });
  return file;
}

const imageStub = { getWidth: () => 2, getHeight: () => 2 };

beforeEach(() => {
  fromArrayBufferMock.mockReset();
  fromArrayBufferMock.mockResolvedValue({ getImage: vi.fn().mockResolvedValue(imageStub) });
  resetRasterSessionCache();
});

describe('buildRasterSourceKey', () => {
  it('is stable for the same content and distinguishes different files', () => {
    const a = makeFile('demo.tif');
    const b = makeFile('demo.tif');
    const other = makeFile('other.tif');
    const newer = makeFile('demo.tif', 1_800_000_000_000);

    expect(buildRasterSourceKey(a)).toBe(buildRasterSourceKey(b));
    expect(buildRasterSourceKey(a)).not.toBe(buildRasterSourceKey(other));
    expect(buildRasterSourceKey(a)).not.toBe(buildRasterSourceKey(newer));
  });
});

describe('keyed session cache', () => {
  it('shares one session across distinct File objects with the same key', async () => {
    // Worker 收到的是 postMessage 结构化克隆出的新 File 对象，
    // 内容相同但身份不同——这正是不加缓存键就会重复解析整幅影像的场景
    const first = makeFile('demo.tif');
    const second = makeFile('demo.tif');
    expect(first).not.toBe(second);

    const sessionA = openRasterSession(first, { cacheKey: buildRasterSourceKey(first) });
    const sessionB = openRasterSession(second, { cacheKey: buildRasterSourceKey(second) });

    expect(sessionA).toBe(sessionB);

    await sessionA.getImage();
    await sessionB.getImage();

    // 只解析一次
    expect(fromArrayBufferMock).toHaveBeenCalledTimes(1);
  });

  it('keeps separate sessions by identity when no key is given', () => {
    const first = makeFile('demo.tif');
    const second = makeFile('demo.tif');

    expect(openRasterSession(first)).not.toBe(openRasterSession(second));
  });

  it('reuses a keyed session and drops it on reset', () => {
    const file = makeFile('demo.tif');
    const key = buildRasterSourceKey(file);

    const session = openRasterSession(file, { cacheKey: key });
    expect(openRasterSession(file, { cacheKey: key })).toBe(session);

    resetRasterSessionCache();
    expect(openRasterSession(file, { cacheKey: key })).not.toBe(session);
  });
});
