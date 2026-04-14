# 网格均值聚合栅格 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为当前 GeoTIFF 工具增加“按命中网格统计主波段有效像元均值，并让地图预览与 GeoTIFF 导出统一使用该聚合结果”的能力。

**Architecture:** 在现有“围栏 -> 网格 -> 导出”链路中新增共享的网格聚合层，先在围栏裁剪窗口内完成像元分桶与均值计算，再把聚合结果分别喂给地图预览、hover 信息和 GeoTIFF 导出。预览与导出必须复用同一套聚合结果和 `outputValue` 规则，避免页面显示与文件结果分叉。

**Tech Stack:** React 19, TypeScript, Zustand, OpenLayers, geotiff, Vitest, Testing Library

---

## File Structure

### Existing Files To Modify

- `src/shared/types/grid.ts`
  为网格单元和汇总信息补充聚合字段，别再让网格只会画框不会算数。

- `src/features/grid/gridStore.ts`
  持有聚合后的网格结果，并给地图和右侧面板提供统一状态。

- `src/shared/geo/grid.ts`
  继续负责几何网格生成，但要和聚合结果的数据结构对齐。

- `src/shared/geo/geotiffExport.ts`
  从“按命中网格写 NoData”升级为“按命中网格写聚合值，未命中网格写 NoData”。

- `src/features/export/exportGeoTiff.ts`
  在导出链路里读取聚合结果或重建聚合窗口，并把网格均值真正写进导出的栅格。

- `src/features/map/useMap.ts`
  负责围栏变化后驱动网格聚合、生成聚合预览、更新 hover 信息和网格图层着色。

- `src/shared/types/raster.ts`
  为 hover 信息补充网格均值和有效像元数等字段。

- `src/features/map/mapUiStore.ts`
  跟进 hover 信息字段，保持 UI 状态类型正确。

- `src/app/layout/RightPanel.tsx`
  展示网格均值、有效像元数等聚合信息。

- `tests/geo/grid.test.ts`
  跟进网格数据结构调整。

- `tests/geo/geotiff-export.test.ts`
  从“只测 NoData 掩膜”升级为“验证网格均值写值”。

- `tests/export/exportGeoTiff.test.ts`
  验证导出时写入的是网格聚合值而不是原始像元。

- `tests/app/right-panel.test.tsx`
  验证 hover 和右侧面板展示聚合信息。

### New Files To Create

- `src/shared/geo/gridAggregation.ts`
  纯函数模块，负责：
  - 建命中网格索引
  - 在裁剪窗口内把像元分配到网格
  - 跳过 `NoData`
  - 计算 `pixelCount`、`validPixelCount`、`meanValue`、`outputValue`
  - 按聚合结果重写栅格值

- `tests/geo/grid-aggregation.test.ts`
  锁住均值计算、`NoData` 跳过、空网格行为和聚合写值。

---

### Task 1: 搭好网格均值聚合纯函数

**Files:**
- Create: `src/shared/geo/gridAggregation.ts`
- Create: `tests/geo/grid-aggregation.test.ts`
- Modify: `src/shared/types/grid.ts`

- [ ] **Step 1: 先写失败测试，锁住网格聚合的最小行为**

```ts
it('aggregates valid primary-band pixels into per-cell mean values', () => {
  const result = aggregateGridCellsFromRasterWindow({
    window: [0, 0, 2, 2],
    width: 2,
    height: 2,
    origin: [0, 2, 0],
    resolution: [1, -1, 0],
    fenceRings: [
      [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
        [0, 0],
      ],
    ],
    gridCellSize: 1,
    band: new Float32Array([1, 3, 5, 7]),
    noDataValue: null,
  });

  expect(result.cellsById['r0-c0']).toMatchObject({
    pixelCount: 1,
    validPixelCount: 1,
    meanValue: 1,
    outputValue: 1,
  });
});

it('skips nodata pixels when computing mean values', () => {
  const result = aggregateGridCellsFromRasterWindow({
    ...baseInput,
    band: new Float32Array([1, -9999, 5, 7]),
    noDataValue: -9999,
  });

  expect(result.cellsById['r0-c1']?.validPixelCount ?? 0).toBe(0);
  expect(result.cellsById['r0-c1']?.meanValue ?? null).toBeNull();
});

it('rewrites raster bands with per-cell output values and keeps non-hit cells as nodata', () => {
  const result = applyGridAggregationToBands({
    bands: [new Float32Array([1, 3, 5, 7])],
    aggregation: {
      cellsById: {
        'r0-c0': { outputValue: 10 },
      },
      ...
    },
    noDataValue: -9999,
  });

  expect(Array.from(result.bands[0])).toEqual([10, -9999, -9999, -9999]);
});
```

- [ ] **Step 2: 跑测试确认红灯**

Run: `PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/pnpm test tests/geo/grid-aggregation.test.ts`

Expected:
- FAIL
- 报错指向缺少 `aggregateGridCellsFromRasterWindow`、`applyGridAggregationToBands` 或新增的网格聚合类型

- [ ] **Step 3: 在 `src/shared/types/grid.ts` 定义聚合结果结构**

至少增加：

```ts
export type GridCellAggregation = {
  cellId: string;
  row: number;
  col: number;
  pixelCount: number;
  validPixelCount: number;
  sumValue: number;
  meanValue: number | null;
  outputValue: number | null;
};

export type GridAggregationResult = {
  cellsById: Record<string, GridCellAggregation>;
};
```

要求：
- 不要把 UI 展示字段和纯聚合字段搅在一起
- `outputValue` 先等于 `meanValue`
- 后续归一化直接改 `outputValue`，别倒回去碰 `meanValue`

- [ ] **Step 4: 写最小实现，把均值聚合和写值逻辑收进 `gridAggregation.ts`**

建议至少提供这些接口：

```ts
export function aggregateGridCellsFromRasterWindow(input: {
  window: [number, number, number, number];
  width: number;
  height: number;
  origin: RasterOrigin;
  resolution: RasterResolution;
  fenceRings: FenceRings;
  gridCellSize: number;
  band: SupportedRasterArray;
  noDataValue: number | null;
}): GridAggregationResult;

export function applyGridAggregationToBands(input: {
  bands: SupportedRasterArray[];
  aggregation: GridAggregationResult;
  width: number;
  height: number;
  window: [number, number, number, number];
  origin: RasterOrigin;
  resolution: RasterResolution;
  fenceRings: FenceRings;
  gridCellSize: number;
  noDataValue: number;
}): { bands: SupportedRasterArray[]; maskedPixelCount: number };
```

实现约束：
- 只按像元中心点所属网格分桶
- 非命中网格直接不入桶
- `NoData` 不参与 `sumValue` 和 `meanValue`
- `validPixelCount === 0` 时，`meanValue` / `outputValue` 必须为 `null`
- 写值时，命中网格写 `outputValue`，其余写 `NoData`

- [ ] **Step 5: 跑测试确认转绿**

Run: `PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/pnpm test tests/geo/grid-aggregation.test.ts`

Expected:
- PASS
- 新增聚合纯函数测试全部通过

- [ ] **Step 6: 提交这一小步**

```bash
git add src/shared/types/grid.ts src/shared/geo/gridAggregation.ts tests/geo/grid-aggregation.test.ts
git commit -m "feat: add grid mean aggregation primitives"
```

---

### Task 2: 把聚合结果接进网格状态和右侧信息

**Files:**
- Modify: `src/features/grid/gridStore.ts`
- Modify: `src/shared/geo/grid.ts`
- Modify: `src/shared/types/raster.ts`
- Modify: `src/features/map/mapUiStore.ts`
- Modify: `src/app/layout/RightPanel.tsx`
- Modify: `tests/geo/grid.test.ts`
- Modify: `tests/app/right-panel.test.tsx`

- [ ] **Step 1: 先写失败测试，锁住右侧展示和 hover 聚合字段**

```ts
it('shows aggregated grid mean and valid pixel count in hover diagnostics', () => {
  useMapUiStore.getState().setHoverInfo({
    coordinate: [1, 2],
    pixel: { row: 3, col: 4 },
    sampleValues: [5],
    gridCellId: 'r10-c20',
    gridMeanValue: 0.62,
    gridValidPixelCount: 18,
    ...
  });

  render(<RightPanel />);

  expect(screen.getByText('0.62')).toBeInTheDocument();
  expect(screen.getByText('18')).toBeInTheDocument();
});
```

- [ ] **Step 2: 跑测试确认红灯**

Run: `PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/pnpm test tests/app/right-panel.test.tsx tests/geo/grid.test.ts`

Expected:
- FAIL
- 报错指向缺少 `gridMeanValue` / `gridValidPixelCount` 字段或右侧面板尚未渲染聚合信息

- [ ] **Step 3: 给 store 和类型补上聚合结果字段**

具体要求：
- `GridCell` 增加可选的 `aggregation`
- `GridSummary` 保持职责单纯，只管汇总，不塞每个格子的统计细节
- `RasterHoverInfo` 新增：

```ts
gridMeanValue: number | null;
gridValidPixelCount: number | null;
```

- `gridStore` 的 `setPreview` 可以保留名字先不洗，但必须能存下带聚合信息的 `cells`

- [ ] **Step 4: 在 `RightPanel.tsx` 增加聚合指标展示**

建议新增两项：

- `网格均值`
- `有效像元数`

显示规则：
- 有值则展示格式化数字
- 无值则显示 `--`

- [ ] **Step 5: 跑测试确认转绿**

Run: `PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/pnpm test tests/app/right-panel.test.tsx tests/geo/grid.test.ts`

Expected:
- PASS
- 右侧面板与网格类型调整相关测试通过

- [ ] **Step 6: 提交这一小步**

```bash
git add src/features/grid/gridStore.ts src/shared/geo/grid.ts src/shared/types/raster.ts src/features/map/mapUiStore.ts src/app/layout/RightPanel.tsx tests/geo/grid.test.ts tests/app/right-panel.test.tsx
git commit -m "feat: surface grid aggregation details in UI state"
```

---

### Task 3: 用聚合结果重建地图预览与 hover 行为

**Files:**
- Modify: `src/features/map/useMap.ts`
- Modify: `src/features/map/mapUiStore.ts`
- Modify: `src/shared/geo/gridAggregation.ts`
- Test: `tests/app/right-panel.test.tsx`
- Test: `tests/app/map-view.test.tsx`

- [ ] **Step 1: 先写失败测试，锁住 hover 读到的是网格均值而不是原始像元**

```ts
it('prefers aggregated grid value for hover diagnostics when the pointer is inside a hit cell', () => {
  // 构造带 aggregation 的 grid cell
  // 触发 pointer hover
  // 期待 hoverInfo.gridMeanValue 为聚合均值
});
```

如果 `tests/app/map-view.test.tsx` 不适合直接测 `pointermove`，至少在 plan 执行时补一个纯函数测试，把“坐标 -> grid cell aggregation”这层锁住。

- [ ] **Step 2: 跑测试确认红灯**

Run: `PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/pnpm test tests/app/map-view.test.tsx tests/app/right-panel.test.tsx`

Expected:
- FAIL
- 报错指向 hover 仍只有原始像元值，缺少聚合值接线

- [ ] **Step 3: 在 `useMap.ts` 里把聚合结果接进围栏和网格重算流程**

实现要求：
- 围栏或 `cellSize` 变化时，先 `buildGridPreview(...)`
- 若缺少 `metadata`、`preview.sampleData` 或不是单波段预览，则仍保留网格几何，但聚合字段为空
- 若具备条件，则在预览窗口或围栏包络对应窗口内计算网格聚合结果
- 把聚合结果合并回 `gridCells`

- [ ] **Step 4: 用聚合值重建地图的视觉表达**

推荐实现：
- 继续保留网格 `VectorLayer`
- 将 `gridLayer` 的 `style` 改为按 `cell.aggregation.outputValue` 决定填充颜色
- 颜色规则继续复用当前可见分类方案或默认渐变方案，别再造一套重复染色系统

实现约束：
- 无 `outputValue` 的网格填充透明
- 有值的网格边框仍保留，避免用户看不出格子
- 如果当前分类方案是规则型，则走规则匹配；是渐变型，则走渐变插值

- [ ] **Step 5: 更新 hover 信息来源**

在 `pointermove` 时：
- 先找到命中的 `GridCell`
- 再把 `gridMeanValue`、`gridValidPixelCount` 写进 `hoverInfo`
- 原始像元值 `sampleValues` 仍保留，避免用户以后追溯不了底层值

- [ ] **Step 6: 跑测试确认转绿**

Run: `PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/pnpm test tests/app/map-view.test.tsx tests/app/right-panel.test.tsx`

Expected:
- PASS
- hover 和右侧面板都能读到聚合结果

- [ ] **Step 7: 提交这一小步**

```bash
git add src/features/map/useMap.ts src/features/map/mapUiStore.ts src/shared/geo/gridAggregation.ts tests/app/map-view.test.tsx tests/app/right-panel.test.tsx
git commit -m "feat: render aggregated grid values on the map"
```

---

### Task 4: 让 GeoTIFF 导出真正写入网格均值

**Files:**
- Modify: `src/shared/geo/geotiffExport.ts`
- Modify: `src/features/export/exportGeoTiff.ts`
- Modify: `tests/geo/geotiff-export.test.ts`
- Modify: `tests/export/exportGeoTiff.test.ts`
- Modify: `tests/geo/geotiff-writer.test.ts`

- [ ] **Step 1: 先写失败测试，锁住导出值变成每格单值**

```ts
it('rewrites all pixels inside each hit cell to that cell mean value', async () => {
  const result = applyGridAggregationToBands({
    bands: [new Float32Array([1, 3, 5, 7])],
    ...
  });

  expect(Array.from(result.bands[0])).toEqual([2, 2, 6, 6]);
});

it('passes aggregated bands into the geotiff writer', async () => {
  await exportFenceGeoTiff({ file, fence, gridCellSize: 1 });

  const call = vi.mocked(writeGeoTiffBuffer).mock.calls[0]?.[0];
  expect(call?.bands[0]).toEqual(new Float32Array([2, 2, 6, 6]));
});
```

- [ ] **Step 2: 跑测试确认红灯**

Run: `PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/pnpm test tests/geo/geotiff-export.test.ts tests/export/exportGeoTiff.test.ts`

Expected:
- FAIL
- 报错指向导出仍保留原始像元值或仍只是按网格写 `NoData`

- [ ] **Step 3: 在 `geotiffExport.ts` 中把写值逻辑切到聚合输出**

实现要求：
- 先对主波段完成聚合，得到每个命中网格的 `outputValue`
- 再用 `applyGridAggregationToBands` 重写全部导出波段
- 若某个命中网格无有效值，则该网格全部写 `NoData`

注意：
- 当前阶段所有波段都统一写入主波段的聚合值，这一点要在实现备注里写清楚
- 如果你觉得这点别扭，那就对了，所以后续多波段策略要单独再定，别偷偷脑补

- [ ] **Step 4: 验证 writer 仍能回读**

Run: `PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/pnpm test tests/geo/geotiff-writer.test.ts tests/export/exportGeoTiff.test.ts tests/geo/geotiff-export.test.ts`

Expected:
- PASS
- 自写 writer 的回读测试继续通过
- 导出编排测试确认写出的 band 已经是聚合值

- [ ] **Step 5: 提交这一小步**

```bash
git add src/shared/geo/geotiffExport.ts src/features/export/exportGeoTiff.ts tests/geo/geotiff-export.test.ts tests/export/exportGeoTiff.test.ts tests/geo/geotiff-writer.test.ts
git commit -m "feat: export aggregated grid mean geotiffs"
```

---

### Task 5: 做整体验证并补文档

**Files:**
- Modify: `docs/superpowers/specs/2026-04-14-grid-mean-aggregation-design.md`
- Modify: `docs/superpowers/plans/2026-04-14-grid-mean-aggregation-plan.md`

- [ ] **Step 1: 跑关键测试集**

Run:

```bash
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/pnpm test tests/geo/grid-aggregation.test.ts tests/geo/grid.test.ts tests/geo/geotiff-export.test.ts tests/export/exportGeoTiff.test.ts tests/geo/geotiff-writer.test.ts tests/app/right-panel.test.tsx tests/app/map-view.test.tsx tests/app/export-controls.test.tsx
```

Expected:
- PASS
- 与网格聚合、预览、导出相关测试全部通过

- [ ] **Step 2: 跑生产构建**

Run: `PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/pnpm build`

Expected:
- PASS
- 若仍出现 chunk size warning，可记录但不视为失败

- [ ] **Step 3: 更新设计文档中的实现状态**

把已完成项回写到：
- `docs/superpowers/specs/2026-04-14-grid-mean-aggregation-design.md`

只补事实，不要往里编“性能很好”这种没证据的屁话。

- [ ] **Step 4: 提交收尾**

```bash
git add docs/superpowers/specs/2026-04-14-grid-mean-aggregation-design.md docs/superpowers/plans/2026-04-14-grid-mean-aggregation-plan.md
git commit -m "docs: capture grid mean aggregation delivery"
```
