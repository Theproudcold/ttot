# 地理坐标影像米制网格适配 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让地理坐标系 `GeoTIFF` 也能继续使用“米”为网格尺寸输入，并在面板、hover、网格生成与导出中同时保留原始坐标显示与米制计算语义。

**Architecture:** 在现有影像元数据之上新增一层“局部米制转换”能力。投影坐标系文件继续走原始米制坐标；地理坐标系文件则以影像中心点建立局部米制平面，所有物理尺寸、面积、网格切分与命中判断都改在该平面中完成，而地图显示、hover 坐标和导出 CRS 继续保留原始坐标系。

**Tech Stack:** React 19, TypeScript, Zustand, OpenLayers, geotiff, proj4, Vitest, Testing Library

---

## File Structure

### Existing Files To Modify

- `src/shared/types/raster.ts`
  为影像元数据补充坐标显示模式、米制范围和局部坐标变换定义。

- `src/shared/geo/crs.ts`
  扩展 CRS 工具，增加地理坐标到局部米制平面的换算能力。

- `src/shared/geo/raster.ts`
  在元信息构建阶段产出 `metricExtent`、`metricWidth`、`metricHeight` 和坐标展示模式。

- `src/shared/geo/grid.ts`
  让网格生成支持“显示坐标”和“米制计算坐标”分离。

- `src/shared/geo/gridAggregation.ts`
  在像元中心归属网格时复用米制转换，避免地理坐标文件继续按“度”切格。

- `src/shared/geo/geotiffExport.ts`
  让导出窗口聚合与命中判断也基于米制计算坐标执行。

- `src/features/map/useMap.ts`
  接入新的网格几何与聚合逻辑，并让 hover 坐标格式根据坐标类型切换精度。

- `src/features/map/MapView.tsx`
  调整 hover 卡片坐标显示精度，避免 GPS 影像范围被两位小数抹平。

- `src/app/layout/LeftPanel.tsx`
  将“影像实际尺寸”“像元大小”等展示分离成原始范围与米制结果两套信息。

- `src/app/layout/RightPanel.tsx`
  展示原始范围、米制实际尺寸、米制网格比例，并让 hover 坐标精度匹配坐标类型。

- `tests/geo/raster.test.ts`
  锁住元数据构建中投影/地理两类影像的差异化输出。

- `tests/geo/grid.test.ts`
  跟进网格生成逻辑，验证地理坐标文件按米切格。

- `tests/geo/grid-aggregation.test.ts`
  验证地理坐标文件下像元归属网格和聚合结果仍正确。

- `tests/geo/geotiff-export.test.ts`
  验证地理坐标文件导出时仍保留原始 CRS，同时按米制网格命中逻辑写值。

- `tests/app/left-panel.test.tsx`
  验证左侧面板同时展示原始经纬度范围与米制尺寸。

- `tests/app/right-panel.test.tsx`
  验证右侧面板的原始范围、米制尺寸、网格比例与 hover 精度。

- `tests/app/map-view.test.tsx`
  验证 hover 卡片对地理坐标文件使用更高精度显示坐标。

### New Files To Create

- `src/shared/geo/metricTransform.ts`
  纯函数模块，负责：
  - 构建投影坐标恒等变换
  - 构建地理坐标局部米制变换
  - 提供 `toMetric` / `fromMetric`
  - 计算米制范围、米制宽高与面积辅助值

- `tests/geo/metric-transform.test.ts`
  锁住局部米制变换的关键行为和回转精度。

---

### Task 1: 搭好局部米制转换纯函数

**Files:**
- Create: `src/shared/geo/metricTransform.ts`
- Create: `tests/geo/metric-transform.test.ts`
- Modify: `src/shared/geo/crs.ts`

- [ ] **Step 1: 先写失败测试，锁住投影坐标和地理坐标两类转换的最小行为**

```ts
it('returns identity metric transform for projected coordinates', () => {
  const transform = createMetricTransform({
    crsCode: 'EPSG:4549',
    boundingBox: [447934.57, 4041573.05, 448017.58, 4041619.78],
  });

  expect(transform.coordinateDisplayMode).toBe('projected');
  expect(transform.toMetric([10, 20])).toEqual([10, 20]);
  expect(transform.fromMetric([10, 20])).toEqual([10, 20]);
});

it('converts geographic coordinates into local metric coordinates', () => {
  const transform = createMetricTransform({
    crsCode: 'EPSG:4326',
    boundingBox: [119.420001, 36.510001, 119.420901, 36.510601],
  });

  const metricLeftBottom = transform.toMetric([119.420001, 36.510001]);
  const metricRightTop = transform.toMetric([119.420901, 36.510601]);

  expect(metricRightTop[0]).toBeGreaterThan(metricLeftBottom[0]);
  expect(metricRightTop[1]).toBeGreaterThan(metricLeftBottom[1]);
  expect(transform.metricWidth).toBeGreaterThan(0);
  expect(transform.metricHeight).toBeGreaterThan(0);
});

it('round-trips geographic coordinates through local metric transform', () => {
  const transform = createMetricTransform({
    crsCode: 'EPSG:4326',
    boundingBox: [119.42, 36.51, 119.421, 36.511],
  });

  const original: [number, number] = [119.4205, 36.5105];
  const roundTrip = transform.fromMetric(transform.toMetric(original));

  expect(roundTrip[0]).toBeCloseTo(original[0], 6);
  expect(roundTrip[1]).toBeCloseTo(original[1], 6);
});
```

- [ ] **Step 2: 跑测试确认红灯**

Run: `PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/pnpm test tests/geo/metric-transform.test.ts`

Expected:
- FAIL
- 报错指向缺少 `createMetricTransform` 或缺少坐标模式/米制范围字段

- [ ] **Step 3: 在 `metricTransform.ts` 写最小实现**

至少提供：

```ts
export type MetricTransform = {
  coordinateDisplayMode: 'projected' | 'geographic';
  metricExtent: { minX: number; minY: number; maxX: number; maxY: number };
  metricWidth: number;
  metricHeight: number;
  toMetric: (point: [number, number]) => [number, number];
  fromMetric: (point: [number, number]) => [number, number];
};

export function createMetricTransform(input: {
  crsCode: string;
  boundingBox: [number, number, number, number];
}): MetricTransform;
```

实现约束：
- 投影坐标系返回恒等变换
- 地理坐标系以影像中心点构建局部米制平面
- 不要在这里掺 UI 展示逻辑

- [ ] **Step 4: 在 `crs.ts` 暴露必要复用接口**

将现有 `isLikelyProjectedCrs` 与新变换能力放到同一套 CRS 工具出口，避免各文件自己重复判断地理/投影坐标类型。

- [ ] **Step 5: 跑测试确认转绿**

Run: `PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/pnpm test tests/geo/metric-transform.test.ts`

Expected:
- PASS
- 地理坐标和平面坐标的转换测试全部通过

- [ ] **Step 6: 提交这一小步**

```bash
git add src/shared/geo/crs.ts src/shared/geo/metricTransform.ts tests/geo/metric-transform.test.ts
git commit -m "feat: add local metric transform for geographic rasters"
```

---

### Task 2: 把米制转换接进影像元数据

**Files:**
- Modify: `src/shared/types/raster.ts`
- Modify: `src/shared/geo/raster.ts`
- Modify: `tests/geo/raster.test.ts`

- [ ] **Step 1: 先写失败测试，锁住元数据同时产出原始范围与米制信息**

```ts
it('builds projected raster metadata with metric extent equal to the source extent', () => {
  const metadata = buildRasterMetadata(projectedInput);

  expect(metadata.coordinateDisplayMode).toBe('projected');
  expect(metadata.metricWidth).toBeCloseTo(83.01, 2);
  expect(metadata.metricHeight).toBeCloseTo(46.73, 2);
});

it('builds geographic raster metadata with degree cell size and meter-based metric dimensions', () => {
  const metadata = buildRasterMetadata({
    ...geographicInput,
    geoKeys: { GeographicTypeGeoKey: 4326 },
    boundingBox: [119.420001, 36.510001, 119.420901, 36.510601],
    resolution: [0.0000004, -0.0000004, 0],
  });

  expect(metadata.coordinateDisplayMode).toBe('geographic');
  expect(metadata.cellSize.unit).toBe('degree');
  expect(metadata.metricWidth).toBeGreaterThan(0);
  expect(metadata.metricHeight).toBeGreaterThan(0);
});
```

- [ ] **Step 2: 跑测试确认红灯**

Run: `PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/pnpm test tests/geo/raster.test.ts`

Expected:
- FAIL
- 报错指向缺少 `coordinateDisplayMode` / `metricWidth` / `metricHeight` / `metricTransform`

- [ ] **Step 3: 扩展 `RasterMetadata` 与相关类型**

在 `src/shared/types/raster.ts` 增加：
- `coordinateDisplayMode`
- `metricExtent`
- `metricWidth`
- `metricHeight`
- `metricTransform`

要求：
- 类型命名明确，不要把原始范围和米制范围混成一个字段
- `cellSize.unit` 仍保留原始像元单位语义

- [ ] **Step 4: 在 `buildRasterMetadata` 中接入米制转换**

使用 `createMetricTransform(...)`：
- 投影坐标文件直接复用原始范围
- 地理坐标文件生成局部米制范围
- 元数据中同时保留原始 `boundingBox` 和新增米制信息

- [ ] **Step 5: 跑测试确认转绿**

Run: `PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/pnpm test tests/geo/raster.test.ts`

Expected:
- PASS
- 投影和地理坐标影像元数据测试都通过

- [ ] **Step 6: 提交这一小步**

```bash
git add src/shared/types/raster.ts src/shared/geo/raster.ts tests/geo/raster.test.ts
git commit -m "feat: attach metric metadata to geographic rasters"
```

---

### Task 3: 修正左侧、右侧和 hover 的坐标与尺寸展示

**Files:**
- Modify: `src/app/layout/LeftPanel.tsx`
- Modify: `src/app/layout/RightPanel.tsx`
- Modify: `src/features/map/MapView.tsx`
- Modify: `tests/app/left-panel.test.tsx`
- Modify: `tests/app/right-panel.test.tsx`
- Modify: `tests/app/map-view.test.tsx`

- [ ] **Step 1: 先写失败测试，锁住地理坐标影像的双重展示语义**

```tsx
it('shows geographic source extent and metric dimensions side by side in the left panel', () => {
  useRasterStore.getState().setMetadata(geographicMetadata);

  render(<LeftPanel />);

  expect(screen.getByText('EPSG:4326')).toBeInTheDocument();
  expect(screen.getByText('119.420001, 36.510001, 119.420901, 36.510601')).toBeInTheDocument();
  expect(screen.getByText(/m x/)).toBeInTheDocument();
});

it('formats geographic hover coordinates with six decimals', () => {
  useRasterStore.getState().setMetadata(geographicMetadata);
  useMapUiStore.getState().setHoverInfo({
    coordinate: [119.420456, 36.510654],
    ...
  });

  render(<RightPanel />);

  expect(screen.getByText('119.420456, 36.510654')).toBeInTheDocument();
});
```

- [ ] **Step 2: 跑测试确认红灯**

Run: `PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/pnpm test tests/app/left-panel.test.tsx tests/app/right-panel.test.tsx tests/app/map-view.test.tsx`

Expected:
- FAIL
- 报错指向实际尺寸仍硬编码为米、坐标仍只保留两位小数

- [ ] **Step 3: 抽出展示格式化辅助函数**

在 `LeftPanel.tsx`、`RightPanel.tsx` 或共享格式化 helper 中补齐：
- 原始范围格式化
- 米制尺寸格式化
- 地理坐标高精度格式化
- 投影坐标常规精度格式化

要求：
- 地理坐标至少 6 位小数
- 投影坐标保留现有 2~3 位小数风格
- 不要再把经纬度范围直接拼成 `m`

- [ ] **Step 4: 左右面板接入双重信息显示**

左侧/右侧至少区分：
- 原始范围
- 米制尺寸
- 米制网格比例

要求：
- 投影坐标文件不退化
- 地理坐标文件明确显示原始范围和换算尺寸两套信息

- [ ] **Step 5: `MapView` hover 卡片接入坐标精度分支**

根据 `metadata.coordinateDisplayMode` 切换：
- 地理坐标：6 位小数
- 投影坐标：2 位小数

- [ ] **Step 6: 跑测试确认转绿**

Run: `PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/pnpm test tests/app/left-panel.test.tsx tests/app/right-panel.test.tsx tests/app/map-view.test.tsx`

Expected:
- PASS
- 地理坐标影像的双重展示与 hover 精度正确

- [ ] **Step 7: 提交这一小步**

```bash
git add src/app/layout/LeftPanel.tsx src/app/layout/RightPanel.tsx src/features/map/MapView.tsx tests/app/left-panel.test.tsx tests/app/right-panel.test.tsx tests/app/map-view.test.tsx
git commit -m "feat: adapt geographic coordinate display and metrics"
```

---

### Task 4: 让网格生成按米制平面处理地理坐标文件

**Files:**
- Modify: `src/shared/geo/grid.ts`
- Modify: `src/shared/types/grid.ts`
- Modify: `src/features/grid/gridStore.ts`
- Modify: `src/features/map/useMap.ts`
- Modify: `tests/geo/grid.test.ts`

- [ ] **Step 1: 先写失败测试，锁住地理坐标文件按米切格**

```ts
it('builds grid cells in geographic rasters using metric cell size rather than degree deltas', () => {
  const preview = buildGridPreview(
    geographicFenceRings,
    10,
    undefined,
    geographicMetadata.metricTransform,
  );

  expect(preview.summary.totalCells).toBeGreaterThan(1);
  expect(preview.summary.totalCells).toBeLessThan(100000);
});
```

- [ ] **Step 2: 跑测试确认红灯**

Run: `PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/pnpm test tests/geo/grid.test.ts`

Expected:
- FAIL
- 报错指向 `buildGridPreview` 还不支持米制变换

- [ ] **Step 3: 扩展 `buildGridPreview` 输入**

让网格生成支持可选 `metricTransform`：
- 投影坐标文件：默认恒等变换
- 地理坐标文件：先在米制平面切格，再反算回原始坐标生成 polygon

要求：
- 不要破坏现有 `GridCell.id / row / col` 语义
- 继续只保留命中围栏的网格

- [ ] **Step 4: `useMap.ts` 接入新的网格生成方式**

围栏变化或 `cellSize` 变化时：
- 使用元数据中的 `metricTransform`
- 先生成地理坐标兼容的网格几何
- 地图上仍显示原始 CRS polygon

- [ ] **Step 5: 跑测试确认转绿**

Run: `PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/pnpm test tests/geo/grid.test.ts tests/app/map-view.test.tsx`

Expected:
- PASS
- 地理坐标网格生成逻辑可用，地图回归不退化

- [ ] **Step 6: 提交这一小步**

```bash
git add src/shared/geo/grid.ts src/shared/types/grid.ts src/features/grid/gridStore.ts src/features/map/useMap.ts tests/geo/grid.test.ts
git commit -m "feat: generate geographic grids in local metric space"
```

---

### Task 5: 让聚合与导出命中判断统一使用米制计算坐标

**Files:**
- Modify: `src/shared/geo/gridAggregation.ts`
- Modify: `src/shared/geo/geotiffExport.ts`
- Modify: `src/features/export/exportGeoTiff.ts`
- Modify: `tests/geo/grid-aggregation.test.ts`
- Modify: `tests/geo/geotiff-export.test.ts`
- Modify: `tests/export/exportGeoTiff.test.ts`

- [ ] **Step 1: 先写失败测试，锁住地理坐标文件导出仍按米制网格命中**

```ts
it('aggregates geographic raster pixels by metric grid size instead of raw degree deltas', () => {
  const result = aggregateGridCellsFromRasterWindow({
    ...geographicWindowInput,
    metricTransform,
    gridCellSize: 10,
  });

  expect(Object.keys(result.cellsById).length).toBeGreaterThan(0);
});

it('preserves source geo keys while exporting a geographic raster with metric grid clipping', async () => {
  await exportFenceGeoTiff({
    file,
    fence,
    gridCellSize: 10,
  });

  expect(writeGeoTiffBuffer).toHaveBeenCalledWith(
    expect.objectContaining({
      geoKeyDirectory: expect.anything(),
      modelTiepoint: expect.any(Array),
    }),
  );
});
```

- [ ] **Step 2: 跑测试确认红灯**

Run: `PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/pnpm test tests/geo/grid-aggregation.test.ts tests/geo/geotiff-export.test.ts tests/export/exportGeoTiff.test.ts`

Expected:
- FAIL
- 报错指向聚合与导出仍在原始经纬度差值空间里判断网格归属

- [ ] **Step 3: 扩展聚合和导出纯函数输入**

为 `aggregateGridCellsFromRasterWindow`、`applyGridAggregationToBands`、导出命中判断等逻辑补充可选 `metricTransform`。

要求：
- 投影坐标文件路径保持不变
- 地理坐标文件使用米制坐标判断网格归属和命中关系
- 导出 GeoTIFF 的 CRS 与 tag 不变

- [ ] **Step 4: `exportFenceGeoTiff` 接入米制命中逻辑**

要求：
- 用户输入的网格尺寸继续按米解释
- 导出仍保留原始 `GeoKeyDirectory` / `ModelTiepoint` / `ModelPixelScale`
- 预览和导出继续共用同一套聚合语义

- [ ] **Step 5: 跑测试确认转绿**

Run: `PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/pnpm test tests/geo/grid-aggregation.test.ts tests/geo/geotiff-export.test.ts tests/export/exportGeoTiff.test.ts`

Expected:
- PASS
- 地理坐标网格聚合与导出回归都通过

- [ ] **Step 6: 提交这一小步**

```bash
git add src/shared/geo/gridAggregation.ts src/shared/geo/geotiffExport.ts src/features/export/exportGeoTiff.ts tests/geo/grid-aggregation.test.ts tests/geo/geotiff-export.test.ts tests/export/exportGeoTiff.test.ts
git commit -m "feat: apply metric grid logic to geographic exports"
```

---

### Task 6: 跑整体验证并收口

**Files:**
- Modify: 如前述实现涉及文件
- Test: `tests/geo/metric-transform.test.ts`
- Test: `tests/geo/raster.test.ts`
- Test: `tests/geo/grid.test.ts`
- Test: `tests/geo/grid-aggregation.test.ts`
- Test: `tests/geo/geotiff-export.test.ts`
- Test: `tests/export/exportGeoTiff.test.ts`
- Test: `tests/app/left-panel.test.tsx`
- Test: `tests/app/right-panel.test.tsx`
- Test: `tests/app/map-view.test.tsx`

- [ ] **Step 1: 运行经纬度适配相关测试集**

Run: `PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/pnpm test tests/geo/metric-transform.test.ts tests/geo/raster.test.ts tests/geo/grid.test.ts tests/geo/grid-aggregation.test.ts tests/geo/geotiff-export.test.ts tests/export/exportGeoTiff.test.ts tests/app/left-panel.test.tsx tests/app/right-panel.test.tsx tests/app/map-view.test.tsx`

Expected:
- PASS
- 经纬度与投影坐标两条路径都通过

- [ ] **Step 2: 运行生产构建**

Run: `PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/pnpm build`

Expected:
- PASS
- 无 TypeScript 编译错误

- [ ] **Step 3: 提交最终收口**

```bash
git add src/shared/types/raster.ts src/shared/geo/crs.ts src/shared/geo/metricTransform.ts src/shared/geo/raster.ts src/shared/geo/grid.ts src/shared/geo/gridAggregation.ts src/shared/geo/geotiffExport.ts src/features/map/useMap.ts src/features/map/MapView.tsx src/features/export/exportGeoTiff.ts src/app/layout/LeftPanel.tsx src/app/layout/RightPanel.tsx tests/geo/metric-transform.test.ts tests/geo/raster.test.ts tests/geo/grid.test.ts tests/geo/grid-aggregation.test.ts tests/geo/geotiff-export.test.ts tests/export/exportGeoTiff.test.ts tests/app/left-panel.test.tsx tests/app/right-panel.test.tsx tests/app/map-view.test.tsx
git commit -m "feat: adapt metric grids for geographic rasters"
```

---

## Notes

- 不要把“显示坐标”和“计算坐标”复用同一个字段名，这会让后续维护直接变成灾难片。
- 如果在实现过程中发现 `grid.ts` 或 `useMap.ts` 明显塞不下新的双坐标逻辑，可以局部拆 helper，但不要顺手搞无关重构。
- 任何地理坐标文件如果无法建立有效米制换算，都必须明确报错，不能偷偷退回按“度”切格。
