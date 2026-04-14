# GeoTIFF 裁剪导出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为当前前端 GeoTIFF 工具增加“按围栏最小外接矩形裁剪原始多波段影像，并将围栏外像元写为 `NoData` 后导出 GeoTIFF”的能力。

**Architecture:** 继续复用现有 `sourceFile + fence` 数据源，不改现有预览加载主链。新增一个纯函数裁剪模块负责“围栏包络 -> 像元窗口 -> 掩膜 -> 导出元信息”，再由 `src/features/export/exportGeoTiff.ts` 串起 `geotiff` 的读取与现成 `writeArrayBuffer` 写出能力，`LeftPanel.tsx` 只负责触发、禁用态和导出中提示。

**Tech Stack:** React 19, TypeScript, Zustand, geotiff, Vitest, Testing Library

---

## File Structure

### Existing Files To Modify

- `src/app/layout/LeftPanel.tsx`
  负责新增 `导出 GeoTIFF` 按钮、导出中禁用态、错误提示和成功后的状态回收。

- `tests/app/export-controls.test.tsx`
  负责覆盖 `导出 GeoTIFF` 按钮的禁用态、点击行为和导出中反馈。

### New Files To Create

- `src/shared/geo/geotiffExport.ts`
  负责纯函数逻辑：围栏包络转像元窗口、像元中心点坐标计算、围栏外写 `NoData`、输出 GeoTIFF 所需 metadata 组装。

- `src/features/export/exportGeoTiff.ts`
  负责读取原始 `File`、调用 `geotiff` 读取窗口栅格、复用 `writeArrayBuffer` 编码、创建 `Blob` 并触发下载。

- `tests/geo/geotiff-export.test.ts`
  负责纯函数测试，锁定窗口换算、NoData 选择、掩膜行为和输出 metadata。

- `tests/export/exportGeoTiff.test.ts`
  负责导出编排测试，锁定 `readBlobBuffer` / `fromArrayBuffer` / `writeArrayBuffer` 的调用链和下载结果。

---

### Task 1: 搭好 GeoTIFF 裁剪纯函数骨架

**Files:**
- Create: `src/shared/geo/geotiffExport.ts`
- Test: `tests/geo/geotiff-export.test.ts`

- [ ] **Step 1: 先写失败测试，锁定窗口换算和围栏掩膜行为**

```ts
it('converts fence bbox into a clamped pixel window', () => {
  expect(
    getPixelWindowFromFenceBoundingBox({
      bbox: [110, 150, 140, 180],
      rasterWidth: 10,
      rasterHeight: 10,
      origin: [100, 200, 0],
      resolution: [10, -10, 0],
    }),
  ).toEqual([1, 2, 4, 5]);
});

it('writes NoData to pixels whose centers fall outside the fence', () => {
  const band = new Float32Array([
    1, 2,
    3, 4,
  ]);

  const masked = applyFenceNoDataMask({
    bands: [band],
    window: [0, 0, 2, 2],
    width: 2,
    height: 2,
    origin: [0, 2, 0],
    resolution: [1, -1, 0],
    fenceRings: [[[0, 2], [1, 2], [1, 1], [0, 1], [0, 2]]],
    noDataValue: -9999,
  });

  expect(Array.from(masked[0])).toEqual([1, -9999, -9999, -9999]);
});
```

- [ ] **Step 2: 跑测试确认红灯**

Run: `pnpm test tests/geo/geotiff-export.test.ts`

Expected:
- FAIL
- 报错应指向缺少 `getPixelWindowFromFenceBoundingBox`、`applyFenceNoDataMask`、`buildGeoTiffExportMetadata` 或相近导出纯函数

- [ ] **Step 3: 写最小实现，把几何和 metadata 逻辑收进单一模块**

建议在 `src/shared/geo/geotiffExport.ts` 提供这些接口：

```ts
export function getPixelWindowFromFenceBoundingBox(input: {
  bbox: [number, number, number, number];
  rasterWidth: number;
  rasterHeight: number;
  origin: [number, number, number?];
  resolution: [number, number, number?];
}): [number, number, number, number] { ... }

export function applyFenceNoDataMask(input: {
  bands: TypedArray[];
  window: [number, number, number, number];
  width: number;
  height: number;
  origin: [number, number, number?];
  resolution: [number, number, number?];
  fenceRings: number[][][];
  noDataValue: number;
}): TypedArray[] { ... }

export function buildGeoTiffExportMetadata(input: {
  width: number;
  height: number;
  origin: [number, number, number?];
  resolution: [number, number, number?];
  bitsPerSample: number[];
  sampleFormat: number[];
  samplesPerPixel: number;
  geoKeys: Record<string, number | string>;
  noDataValue: number;
  photometricInterpretation?: number;
}): Record<string, unknown> { ... }
```

实现约束：
- 像元窗口必须按围栏包络计算，并裁到影像范围内
- 若围栏包络与影像无交集，直接抛错
- 像元是否落入围栏，按像元中心点判断，复用 `isPointInFence`
- 输出 metadata 必须显式写入 `ModelPixelScale`、`ModelTiepoint`、`BitsPerSample`、`SampleFormat`、`SamplesPerPixel`
- 直接把 `image.getGeoKeys()` 展开到 metadata 顶层，交给 `writeArrayBuffer` 生成 `GeoKeyDirectory`

- [ ] **Step 4: 补充 NoData 选择测试并实现回退规则**

测试至少覆盖：

```ts
it('reuses source nodata when it exists', () => {
  expect(pickExportNoDataValue({ sourceNoDataValue: -9999 })).toBe(-9999);
});

it('falls back to a safe sentinel for float rasters', () => {
  expect(
    pickExportNoDataValue({
      sourceNoDataValue: null,
      sampleFormat: [3],
      bitsPerSample: [32],
      bands: [new Float32Array([0.1, 0.2, 0.9])],
    }),
  ).toBe(-3.4028234663852886e38);
});
```

实现要求：
- 有原始 `GDALNoData` 时优先复用
- 无原始 `NoData` 时，根据 `SampleFormat + BitsPerSample` 选取类型边界值
- 若候选值已出现在窗口数据里，再退到另一侧边界值

- [ ] **Step 5: 跑测试确认转绿**

Run: `pnpm test tests/geo/geotiff-export.test.ts`

Expected:
- PASS
- 新增导出纯函数测试全部通过

- [ ] **Step 6: 提交这一小步**

```bash
git add tests/geo/geotiff-export.test.ts src/shared/geo/geotiffExport.ts
git commit -m "feat: add geotiff clip export primitives"
```

---

### Task 2: 实现浏览器端 GeoTIFF 导出编排

**Files:**
- Create: `src/features/export/exportGeoTiff.ts`
- Test: `tests/export/exportGeoTiff.test.ts`

- [ ] **Step 1: 写失败测试，锁定读取窗口、编码和下载链路**

```ts
it('reads the clipped raster window and writes a new geotiff blob', async () => {
  const result = await exportFenceGeoTiff({
    file,
    fence,
    filename: 'test2-clipped.tif',
  });

  expect(fromArrayBuffer).toHaveBeenCalledTimes(1);
  expect(image.readRasters).toHaveBeenCalledWith(
    expect.objectContaining({
      window: [1, 2, 4, 5],
      interleave: false,
    }),
  );
  expect(writeArrayBuffer).toHaveBeenCalledTimes(1);
  expect(result.filename).toBe('test2-clipped.tif');
});
```

- [ ] **Step 2: 跑测试确认红灯**

Run: `pnpm test tests/export/exportGeoTiff.test.ts`

Expected:
- FAIL
- 报错应指向缺少 `exportFenceGeoTiff` 或缺少 `writeArrayBuffer` 调用

- [ ] **Step 3: 在导出模块里串起现有 `geotiff` 读写能力**

实现建议：

```ts
import { fromArrayBuffer, writeArrayBuffer } from 'geotiff';

export async function exportFenceGeoTiff(input: {
  file: File;
  fence: FenceFeature;
  filename?: string;
}): Promise<{ blob: Blob; filename: string }> {
  const buffer = await readBlobBuffer(input.file);
  const tiff = await fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  const window = getPixelWindowFromFenceBoundingBox(...);
  const rasters = await image.readRasters({ window, interleave: false });
  const noDataValue = pickExportNoDataValue(...);
  const maskedBands = applyFenceNoDataMask(...);
  const metadata = buildGeoTiffExportMetadata(...);
  const output = writeArrayBuffer(maskedBands, metadata);

  return {
    blob: new Blob([output], { type: 'image/tiff' }),
    filename: input.filename ?? buildDefaultExportFilename(input.file.name),
  };
}
```

实现约束：
- 复用 `src/shared/geo/raster.ts` 里的 `readBlobBuffer`，别重复造本地文件读取轮子
- 只读围栏包络窗口，不允许整图读完再裁
- `readRasters` 要求 `interleave: false`，保持多波段数组结构，便于逐波段写 `NoData`
- 导出 metadata 必须保留 `image.getGeoKeys()`、`image.getBitsPerSample()`、`image.getSampleFormat()`、`image.getSamplesPerPixel()`
- `GDAL_NODATA` 需写成字符串标签值，保证下游 GIS 更容易识别

- [ ] **Step 4: 补下载行为测试并实现浏览器下载辅助函数**

测试至少覆盖：

```ts
it('creates an object url and triggers anchor download', async () => {
  await downloadExportedGeoTiff(new Blob(['x']), 'demo.tif');
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  expect(anchor.click).toHaveBeenCalledTimes(1);
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
});
```

实现要求：
- 下载辅助函数可以放在 `src/features/export/exportGeoTiff.ts` 内部
- 成功和失败都要回收 `ObjectURL`
- 默认导出文件名建议为 `<原文件名去后缀>-clipped.tif`

- [ ] **Step 5: 跑测试确认转绿**

Run: `pnpm test tests/export/exportGeoTiff.test.ts`

Expected:
- PASS
- 新增导出编排测试全部通过

- [ ] **Step 6: 提交这一小步**

```bash
git add tests/export/exportGeoTiff.test.ts src/features/export/exportGeoTiff.ts
git commit -m "feat: add browser geotiff clip export flow"
```

---

### Task 3: 接线左侧导出按钮与状态反馈

**Files:**
- Modify: `src/app/layout/LeftPanel.tsx`
- Modify: `tests/app/export-controls.test.tsx`

- [ ] **Step 1: 先写失败测试，锁定按钮可用性和导出中状态**

```tsx
it('disables geotiff export when no raster or fence exists', () => {
  render(<LeftPanel />);
  expect(screen.getByRole('button', { name: '导出 GeoTIFF' })).toBeDisabled();
});

it('shows exporting state while geotiff export is pending', async () => {
  exportFenceGeoTiff.mockReturnValue(new Promise(() => undefined));

  render(<LeftPanel />);
  fireEvent.click(screen.getByRole('button', { name: '导出 GeoTIFF' }));

  expect(screen.getByRole('button', { name: '正在导出 GeoTIFF' })).toBeDisabled();
});
```

- [ ] **Step 2: 跑测试确认红灯**

Run: `pnpm test tests/app/export-controls.test.tsx`

Expected:
- FAIL
- 缺少 `导出 GeoTIFF` 按钮或按钮状态不符合预期

- [ ] **Step 3: 在 `LeftPanel.tsx` 增加导出入口和局部状态**

建议增加局部状态：

```tsx
const [isExportingGeoTiff, setIsExportingGeoTiff] = useState(false);
const [geoTiffExportMessage, setGeoTiffExportMessage] = useState<string | null>(null);
```

按钮接线要求：
- 按钮放在 `导出围栏` / `导出网格` 同一组
- `!sourceFile || !fence || isExportingGeoTiff` 时禁用
- 点击后清空旧消息，显示 `正在导出 GeoTIFF`
- 成功后调用下载辅助函数，并显示 `GeoTIFF 导出完成`
- 失败时显示用户可读提示，例如 `GeoTIFF 导出失败：围栏超出影像范围`

- [ ] **Step 4: 补成功/失败提示测试并实现文案回收**

测试至少覆盖：
- 导出成功后恢复按钮可点击
- 导出失败后展示错误文本
- 导出失败不影响 `导出围栏` / `导出网格` 按钮

推荐断言：

```tsx
expect(screen.getByText('GeoTIFF 导出完成')).toBeInTheDocument();
expect(screen.getByText(/GeoTIFF 导出失败/)).toBeInTheDocument();
```

- [ ] **Step 5: 跑测试确认转绿**

Run: `pnpm test tests/app/export-controls.test.tsx`

Expected:
- PASS
- 现有 GeoJSON 导出测试继续通过

- [ ] **Step 6: 提交这一小步**

```bash
git add tests/app/export-controls.test.tsx src/app/layout/LeftPanel.tsx
git commit -m "feat: add geotiff export controls"
```

---

### Task 4: 全量回归并人工验收导出文件

**Files:**
- Verify only: `tests/geo/geotiff-export.test.ts`
- Verify only: `tests/export/exportGeoTiff.test.ts`
- Verify only: `tests/app/export-controls.test.tsx`

- [ ] **Step 1: 跑导出相关测试集合**

Run: `pnpm test tests/geo/geotiff-export.test.ts tests/export/exportGeoTiff.test.ts tests/app/export-controls.test.tsx`

Expected:
- PASS
- 三组测试都通过，没有 `act(...)` 或未清理 URL 的告警

- [ ] **Step 2: 跑全量测试**

Run: `pnpm test`

Expected:
- PASS
- 现有 `76` 个用例外加新增导出用例全部通过

- [ ] **Step 3: 跑生产构建**

Run: `pnpm build`

Expected:
- PASS
- `vite build` 成功，没有 TypeScript 类型错误

- [ ] **Step 4: 做一次手工验收**

手工验收清单：
- 上传 `test2.tif`
- 绘制一个明显小于整图的围栏
- 点击 `导出 GeoTIFF`
- 用本项目的上传入口再次打开导出的 `tif`
- 确认导出影像范围缩小、空间位置不漂、围栏外区域显示为无数据

- [ ] **Step 5: 整理最终验收结论并准备交付说明**

验收说明至少包含：
- 导出按钮在何种条件下可用
- 导出文件名规则
- 围栏外像元写 `NoData` 的验证结果
- 用导出的 `.tif` 回传到当前页面后二次预览是否正常
