# GeoTIFF 分阶段加载与网格预览优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让本地 `GeoTIFF` 上传后先快速显示元信息与影像，再后台补有效区域与网格预览，同时把默认网格尺寸调整为 `10m` 并补齐比例、预览量与视图适配反馈。

**Architecture:** 保持现有 `React + Zustand + OpenLayers + GeoTIFF` 架构不变，把读取流程拆成“元信息优先、影像优先、后台掩膜”三段；网格层继续沿用现有 store 和地图图层，但把展示摘要与视图交互补完整。实现顺序严格按 TDD 执行，每个任务只做一类改动，跑完定向测试再进入下一步。

**Tech Stack:** React 19, TypeScript, Zustand, OpenLayers, geotiff.js, Vitest, Testing Library

---

## File Map

### Existing files to modify

- `src/shared/geo/raster.ts`
  - 负责 `GeoTIFF` 文件读取、进度计算、元信息整理、有效区域提取
- `src/shared/types/raster.ts`
  - 负责 raster 元信息、有效区域、加载状态类型定义
- `src/features/map/rasterStore.ts`
  - 负责当前文件、元信息、读取阶段、有效区域状态
- `src/features/map/useRasterLoader.ts`
  - 负责上传后加载流程编排
- `src/features/map/useMap.ts`
  - 负责底图图层、围栏交互、网格预览图层、视图控制
- `src/features/grid/gridStore.ts`
  - 负责默认网格尺寸、网格预览摘要
- `src/features/fence/fenceStore.ts`
  - 负责围栏校验提示
- `src/app/layout/LeftPanel.tsx`
  - 负责文件信息、网格参数、阶段状态展示
- `src/app/layout/RightPanel.tsx`
  - 负责网格总量、预览量、比例、告警展示
- `src/app/layout/TopBar.tsx`
  - 负责全局状态与阶段信息展示
- `src/features/map/MapView.tsx`
  - 负责地图工作区顶部提示与适配按钮
- `src/shared/geo/grid.ts`
  - 负责网格预览摘要与降级信息

### Existing tests to modify

- `tests/geo/raster.test.ts`
- `tests/geo/grid.test.ts`
- `tests/features/raster-store.test.ts`
- `tests/app/left-panel.test.tsx`
- `tests/app/right-panel.test.tsx`
- `tests/app/top-bar.test.tsx`

### New tests likely needed

- `tests/app/map-view.test.tsx`
  - 覆盖地图提示文案与适配按钮渲染

## Task 1: 把默认网格尺寸和比例展示改正确

**Files:**
- Modify: `src/features/grid/gridStore.ts`
- Modify: `src/app/layout/LeftPanel.tsx`
- Modify: `src/app/layout/RightPanel.tsx`
- Test: `tests/app/left-panel.test.tsx`
- Test: `tests/app/right-panel.test.tsx`

- [ ] **Step 1: 写失败测试，固定默认网格为 `10m`**

```tsx
it('uses 10 meters as the default grid cell size', () => {
  render(<LeftPanel />);
  expect(screen.getByDisplayValue('10')).toBeInTheDocument();
});
```

- [ ] **Step 2: 运行定向测试确认失败**

Run: `pnpm test tests/app/left-panel.test.tsx`
Expected: FAIL，默认值仍然是 `1`

- [ ] **Step 3: 写失败测试，固定右侧展示影像实际尺寸与网格比例**

```tsx
it('shows raster physical size and grid ratios when metadata exists', () => {
  // 准备 metadata + gridSummary
  expect(screen.getByText('83.01m x 46.73m')).toBeInTheDocument();
  expect(screen.getByText(/12\.0%/)).toBeInTheDocument();
});
```

- [ ] **Step 4: 运行定向测试确认失败**

Run: `pnpm test tests/app/right-panel.test.tsx`
Expected: FAIL，当前还没有尺寸与比例展示

- [ ] **Step 5: 做最小实现**

```ts
const INITIAL_STATE = {
  cellSize: 10,
  summary: null,
  cells: [],
};
```

```tsx
const rasterWidth = metadata ? metadata.boundingBox[2] - metadata.boundingBox[0] : null;
const widthRatio = metadata ? (cellSize / rasterWidth) * 100 : null;
```

- [ ] **Step 6: 运行定向测试确认通过**

Run: `pnpm test tests/app/left-panel.test.tsx tests/app/right-panel.test.tsx`
Expected: PASS

- [ ] **Step 7: 提交这一小步**

```bash
git add src/features/grid/gridStore.ts src/app/layout/LeftPanel.tsx src/app/layout/RightPanel.tsx tests/app/left-panel.test.tsx tests/app/right-panel.test.tsx
git commit -m "feat: set 10m default grid and show grid ratios"
```

## Task 2: 让元信息先出来，别再一直是 `--`

**Files:**
- Modify: `src/shared/geo/raster.ts`
- Modify: `src/shared/types/raster.ts`
- Modify: `src/features/map/rasterStore.ts`
- Modify: `src/features/map/useRasterLoader.ts`
- Modify: `src/app/layout/LeftPanel.tsx`
- Modify: `src/app/layout/TopBar.tsx`
- Modify: `src/features/map/MapView.tsx`
- Test: `tests/geo/raster.test.ts`
- Test: `tests/features/raster-store.test.ts`
- Test: `tests/app/left-panel.test.tsx`
- Test: `tests/app/top-bar.test.tsx`

- [ ] **Step 1: 写失败测试，固定“文件一选中后状态进入阶段式读取”**

```ts
it('tracks metadata and validity phases separately', () => {
  useRasterStore.getState().selectFile(file);
  expect(useRasterStore.getState().loadingPhase).toBe('等待读取');
  expect(useRasterStore.getState().validityStatus).toBe('idle');
});
```

- [ ] **Step 2: 写失败测试，固定“元信息就绪后立刻显示尺寸/CRS/像元大小”**

```tsx
it('renders raster metadata as soon as metadata is available', () => {
  // setMetadata(...)
  expect(screen.getByText('5647 x 3179')).toBeInTheDocument();
  expect(screen.getByText('EPSG:4549')).toBeInTheDocument();
  expect(screen.getByText('0.0147 m')).toBeInTheDocument();
});
```

- [ ] **Step 3: 运行定向测试确认失败**

Run: `pnpm test tests/features/raster-store.test.ts tests/app/left-panel.test.tsx tests/app/top-bar.test.tsx`
Expected: 至少一个 FAIL，说明状态和展示还未完全覆盖

- [ ] **Step 4: 在 `raster.ts` 里保持“元信息读取”和“有效区域读取”分离**

```ts
export async function loadRasterMetadata(...) { /* 只读 metadata */ }
export async function loadRasterValidityMask(...) { /* 后台补 mask */ }
```

- [ ] **Step 5: 在 `useRasterLoader.ts` 里拆成两个 effect**

```ts
useEffect(() => {
  // sourceFile -> metadata
}, [...]);

useEffect(() => {
  // metadata ready -> validityMask
}, [...]);
```

- [ ] **Step 6: 调整顶部、左侧、地图提示文案**

```tsx
status === 'loading'
  ? `读取进度 ${loadingProgress ?? '--'}%`
  : validityStatus === 'loading'
    ? '影像已显示，正在后台准备有效区域'
    : '网格预览会根据缩放级别降级显示'
```

- [ ] **Step 7: 运行定向测试确认通过**

Run: `pnpm test tests/geo/raster.test.ts tests/features/raster-store.test.ts tests/app/left-panel.test.tsx tests/app/top-bar.test.tsx`
Expected: PASS

- [ ] **Step 8: 提交这一小步**

```bash
git add src/shared/geo/raster.ts src/shared/types/raster.ts src/features/map/rasterStore.ts src/features/map/useRasterLoader.ts src/app/layout/LeftPanel.tsx src/app/layout/TopBar.tsx src/features/map/MapView.tsx tests/geo/raster.test.ts tests/features/raster-store.test.ts tests/app/left-panel.test.tsx tests/app/top-bar.test.tsx
git commit -m "feat: show GeoTIFF metadata before background mask loading"
```

## Task 3: 修读取进度，别再卡 `0%`

**Files:**
- Modify: `src/shared/geo/raster.ts`
- Modify: `src/features/map/useRasterLoader.ts`
- Test: `tests/geo/raster.test.ts`
- Test: `tests/app/top-bar.test.tsx`

- [ ] **Step 1: 写失败测试，固定“收到字节后进度至少为 `1%`”**

```ts
it('never reports 0 percent after bytes start arriving', () => {
  expect(calculateProgressPercent(1, 1024)).toBe(1);
});
```

- [ ] **Step 2: 写失败测试，固定“本地文件读取阶段进度文案可展示”**

```tsx
it('shows loading progress during local file reading', () => {
  useRasterStore.getState().setLoadingProgress('正在读取本地文件', 1);
  expect(screen.getByText('读取进度：1%')).toBeInTheDocument();
});
```

- [ ] **Step 3: 运行定向测试确认失败**

Run: `pnpm test tests/geo/raster.test.ts tests/app/top-bar.test.tsx`
Expected: FAIL，当前可能仍返回 `0`

- [ ] **Step 4: 用最小实现修正本地文件读取进度**

```ts
const roundedProgress = Math.round((receivedBytes / totalBytes) * 100);
return receivedBytes > 0 ? Math.max(1, roundedProgress) : roundedProgress;
```

```ts
reader.onprogress = (event) => {
  onProgress?.(calculateProgressPercent(event.loaded, event.total, 0));
};
```

- [ ] **Step 5: 运行定向测试确认通过**

Run: `pnpm test tests/geo/raster.test.ts tests/app/top-bar.test.tsx`
Expected: PASS

- [ ] **Step 6: 提交这一小步**

```bash
git add src/shared/geo/raster.ts src/features/map/useRasterLoader.ts tests/geo/raster.test.ts tests/app/top-bar.test.tsx
git commit -m "fix: report local GeoTIFF read progress accurately"
```

## Task 4: 把地图视图和适配操作补齐

**Files:**
- Modify: `src/features/map/useMap.ts`
- Modify: `src/features/map/MapView.tsx`
- Test: `tests/app/map-view.test.tsx`

- [ ] **Step 1: 写失败测试，固定地图工作区展示“适配影像/适配围栏”按钮**

```tsx
it('renders fit actions for raster and fence navigation', () => {
  render(<MapView />);
  expect(screen.getByRole('button', { name: '适配影像' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '适配围栏' })).toBeInTheDocument();
});
```

- [ ] **Step 2: 运行定向测试确认失败**

Run: `pnpm test tests/app/map-view.test.tsx`
Expected: FAIL，当前还没有按钮

- [ ] **Step 3: 在 `useMap.ts` 中保留基于 `source.getView()` 的视图来源，并暴露适配操作**

```ts
function fitToRaster() {
  map.getView().fit(metadata.boundingBox, { padding: [24, 24, 24, 24] });
}

function fitToFence() {
  map.getView().fit(fence.summary.bbox, { padding: [24, 24, 24, 24], maxZoom: 22 });
}
```

- [ ] **Step 4: 在 `MapView.tsx` 中接出两个按钮**

```tsx
<button type="button">适配影像</button>
<button type="button" disabled={!fence}>适配围栏</button>
```

- [ ] **Step 5: 运行定向测试确认通过**

Run: `pnpm test tests/app/map-view.test.tsx`
Expected: PASS

- [ ] **Step 6: 提交这一小步**

```bash
git add src/features/map/useMap.ts src/features/map/MapView.tsx tests/app/map-view.test.tsx
git commit -m "feat: add map fit controls for raster and fence"
```

## Task 5: 把网格预览和有效区域提示补完整

**Files:**
- Modify: `src/shared/geo/grid.ts`
- Modify: `src/shared/geo/fence.ts`
- Modify: `src/features/fence/fenceStore.ts`
- Modify: `src/features/map/useMap.ts`
- Modify: `src/app/layout/RightPanel.tsx`
- Test: `tests/geo/grid.test.ts`
- Test: `tests/geo/fence.test.ts`
- Test: `tests/app/right-panel.test.tsx`

- [ ] **Step 1: 写失败测试，固定网格摘要包含总量、预览量和降级告警**

```ts
it('returns downgraded preview metadata for dense grids', () => {
  expect(preview.summary.isPreviewLimited).toBe(true);
  expect(preview.summary.previewCellCount).toBeLessThan(preview.summary.totalCells);
  expect(preview.summary.warning).toContain('抽样预览');
});
```

- [ ] **Step 2: 写失败测试，固定围栏非法时右侧能看到明确提示**

```tsx
it('shows validation and grid warnings', () => {
  expect(screen.getByText('围栏必须落在影像有效数据范围内')).toBeInTheDocument();
  expect(screen.getByText('网格过密，当前按 3x3 抽样预览。')).toBeInTheDocument();
});
```

- [ ] **Step 3: 运行定向测试确认失败**

Run: `pnpm test tests/geo/grid.test.ts tests/geo/fence.test.ts tests/app/right-panel.test.tsx`
Expected: FAIL，说明当前摘要或提示尚未齐全

- [ ] **Step 4: 在网格摘要里保留完整预览信息**

```ts
summary: {
  totalCells,
  previewCellCount: cells.length,
  isPreviewLimited: previewStride > 1,
  previewStride,
  warning,
}
```

- [ ] **Step 5: 在围栏 store 与地图交互里连通校验提示**

```ts
setValidationMessage('围栏必须落在影像有效数据范围内');
```

- [ ] **Step 6: 在右侧面板显示总量、预览量和告警**

```tsx
<dd>{gridSummary ? `${gridSummary.previewCellCount} / ${gridSummary.totalCells}` : '--'}</dd>
```

- [ ] **Step 7: 运行定向测试确认通过**

Run: `pnpm test tests/geo/grid.test.ts tests/geo/fence.test.ts tests/app/right-panel.test.tsx`
Expected: PASS

- [ ] **Step 8: 提交这一小步**

```bash
git add src/shared/geo/grid.ts src/shared/geo/fence.ts src/features/fence/fenceStore.ts src/features/map/useMap.ts src/app/layout/RightPanel.tsx tests/geo/grid.test.ts tests/geo/fence.test.ts tests/app/right-panel.test.tsx
git commit -m "feat: surface grid preview summary and fence warnings"
```

## Task 6: 做全量验证并收尾

**Files:**
- Modify: `README.md`（仅当界面能力说明已明显过时）
- Verify: `tests/**`
- Verify: `src/**`

- [ ] **Step 1: 跑全量测试**

Run: `pnpm test`
Expected: 全部 PASS

- [ ] **Step 2: 跑生产构建**

Run: `pnpm build`
Expected: BUILD SUCCESS

- [ ] **Step 3: 人工验证本地关键路径**

Run:

```bash
pnpm dev
```

Expected:
- 上传 `test2.tif` 后先看到文件名、CRS、像元大小、影像实际尺寸
- 读取进度不再长时间停在 `0%`
- 地图能尽快看到影像
- 有效区域状态会从 `后台处理中` 变为 `已就绪`
- 默认网格尺寸为 `10`
- 右侧能看到网格总量、预览量、比例和告警
- `适配影像` / `适配围栏` 可用

- [ ] **Step 4: 如有必要更新 README**

```md
- 支持本地 GeoTIFF 上传
- 支持分阶段读取状态展示
- 支持围栏、网格预览与导出
```

- [ ] **Step 5: 提交收尾**

```bash
git add README.md src tests
git commit -m "feat: improve GeoTIFF loading and grid preview workflow"
```
