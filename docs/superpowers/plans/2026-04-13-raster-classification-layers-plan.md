# Raster 分类图层与 NDVI 色带 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为当前 GeoTIFF 前端工具增加 `NDVI 默认` 彩色渐变方案、多个命名分类方案管理、自定义离散分段规则，以及更紧凑的图例与 hover 命中信息。

**Architecture:** 继续复用现有 `preview.sampleData` / `preview.sampleRanges` 作为渲染输入，不改 GeoTIFF 读取主链。把当前单一 `rasterRenderSettings` 升级为 `classificationLayers + active/visible layer id`，由 `src/shared/geo/raster.ts` 提供渐变/离散两套映射纯函数，`useMap.ts` 只消费“当前可见方案”进行重绘和 hover 命中计算，`LeftPanel.tsx` 负责方案列表与编辑器，`MapView.tsx` / `RightPanel.tsx` 负责图例与结果展示。

**Tech Stack:** React 19, TypeScript, Zustand, OpenLayers, Vitest, Testing Library

---

## File Structure

### Existing Files To Modify

- `src/shared/types/raster.ts`
  负责新增分类方案、渐变停靠点、离散规则、hover 命中结果等类型。

- `src/shared/geo/raster.ts`
  负责新增 NDVI 预设色带、连续插值、离散规则命中、图例数据、当前可见方案着色等纯函数。

- `src/features/map/mapUiStore.ts`
  负责把单一分级设置升级为多方案状态与对应 actions。

- `src/features/map/useMap.ts`
  负责读取当前可见分类方案，生成地图预览图、hover 命中信息。

- `src/features/map/MapView.tsx`
  负责根据当前可见方案显示渐变图例或离散图例。

- `src/app/layout/LeftPanel.tsx`
  负责方案列表、显隐开关、当前方案编辑器。

- `src/app/layout/RightPanel.tsx`
  负责 hover 命中的方案名、规则标签、颜色块展示。

- `src/app/styles.css`
  负责紧凑色带图例、方案列表、规则编辑器的样式。

### Existing Tests To Modify

- `tests/geo/raster.test.ts`
- `tests/features/map-ui-store.test.ts`
- `tests/app/left-panel.test.tsx`
- `tests/app/map-view.test.tsx`
- `tests/app/right-panel.test.tsx`

---

### Task 1: 类型与纯函数升级

**Files:**
- Modify: `src/shared/types/raster.ts`
- Modify: `src/shared/geo/raster.ts`
- Test: `tests/geo/raster.test.ts`

- [ ] **Step 1: 写失败测试，覆盖分类方案和命中逻辑**

```ts
it('builds NDVI gradient legend stops', () => {
  expect(buildNdviGradientStops()).toEqual([
    { offset: 0, color: '#6b5744' },
    { offset: 1, color: '#155d27' },
  ]);
});

it('matches discrete classification rules with open-ended max', () => {
  const rule = matchDiscreteClassificationRule(0.82, [
    { min: 0, max: 0.5, color: '#808080', label: '0.00 ~ 0.50' },
    { min: 0.5, max: 0.7, color: '#d9b44a', label: '0.50 ~ 0.70' },
    { min: 0.7, max: null, color: '#2f7d32', label: '0.70+' },
  ]);
  expect(rule?.label).toBe('0.70+');
});
```

- [ ] **Step 2: 跑测试确认确实是红灯**

Run: `pnpm test tests/geo/raster.test.ts`

Expected:
- FAIL
- 报错应指向缺少 `buildNdviGradientStops`、`matchDiscreteClassificationRule`、`buildGradientLegend` 或相近纯函数

- [ ] **Step 3: 实现最小生产代码**

需要补的内容：

- `RasterClassificationLayer`
- `RasterClassificationMode`
- `RasterGradientStop`
- `RasterClassificationRule`
- `RasterLayerMatchResult`
- `buildDefaultNdviClassificationLayer()`
- `buildGradientLegendStops()`
- `interpolateGradientColor()`
- `matchDiscreteClassificationRule()`
- `buildGradientPreviewRgba()`
- `buildDiscretePreviewRgba()`

建议最小接口：

```ts
export function buildDefaultNdviClassificationLayer(): RasterClassificationLayer {
  return {
    id: 'ndvi-default',
    name: 'NDVI 默认',
    visible: true,
    mode: 'gradient',
    preset: 'ndvi',
    min: null,
    max: null,
    gradientStops: [...],
    rules: [],
  };
}
```

- [ ] **Step 4: 跑测试确认转绿**

Run: `pnpm test tests/geo/raster.test.ts`

Expected:
- PASS
- 新增测试与已有 `raster` 相关测试都通过

- [ ] **Step 5: 提交这一小步**

```bash
git add tests/geo/raster.test.ts src/shared/types/raster.ts src/shared/geo/raster.ts
git commit -m "feat: add raster classification layer primitives"
```

---

### Task 2: 状态层从单一设置升级为多命名方案

**Files:**
- Modify: `src/features/map/mapUiStore.ts`
- Modify: `tests/features/map-ui-store.test.ts`

- [ ] **Step 1: 写失败测试，覆盖新增/复制/删除/切换行为**

```ts
it('initializes with the default NDVI classification layer', () => {
  expect(useMapUiStore.getState().classificationLayers).toHaveLength(1);
  expect(useMapUiStore.getState().classificationLayers[0].name).toBe('NDVI 默认');
});

it('duplicates and removes classification layers with fallback ids', () => {
  const store = useMapUiStore.getState();
  const duplicateId = store.duplicateClassificationLayer('ndvi-default');
  store.deleteClassificationLayer('ndvi-default');
  expect(store.activeClassificationLayerId).toBe(duplicateId);
});
```

- [ ] **Step 2: 跑测试确认红灯**

Run: `pnpm test tests/features/map-ui-store.test.ts`

Expected:
- FAIL
- 缺少 `classificationLayers`、`activeClassificationLayerId`、相关 store actions

- [ ] **Step 3: 实现最小状态与 actions**

把当前：

```ts
rasterRenderSettings
setRasterRenderSettings()
```

升级为：

```ts
classificationLayers
activeClassificationLayerId
visibleClassificationLayerId
addClassificationLayer()
updateClassificationLayer()
duplicateClassificationLayer()
deleteClassificationLayer()
setActiveClassificationLayer()
setVisibleClassificationLayer()
toggleClassificationLayerVisibility()
```

约束：

- 初始状态自动注入 `NDVI 默认`
- 删除当前活动方案时，自动回退到下一可用方案
- 只要存在可见方案，`visibleClassificationLayerId` 必须指向其中之一

- [ ] **Step 4: 跑测试确认转绿**

Run: `pnpm test tests/features/map-ui-store.test.ts`

Expected:
- PASS

- [ ] **Step 5: 提交这一小步**

```bash
git add tests/features/map-ui-store.test.ts src/features/map/mapUiStore.ts
git commit -m "feat: add classification layer store state"
```

---

### Task 3: 左侧面板方案列表与编辑器

**Files:**
- Modify: `src/app/layout/LeftPanel.tsx`
- Modify: `src/app/styles.css`
- Test: `tests/app/left-panel.test.tsx`

- [ ] **Step 1: 写失败测试，覆盖方案列表和两种编辑器**

```tsx
it('renders the default NDVI layer and allows creating a custom discrete layer', () => {
  render(<LeftPanel />);
  expect(screen.getByText('NDVI 默认')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '新建方案' })).toBeInTheDocument();
});

it('renders discrete rule editor rows for the active custom layer', () => {
  // 预置一个 discrete layer
  render(<LeftPanel />);
  expect(screen.getByLabelText('规则最小值-0')).toBeInTheDocument();
  expect(screen.getByLabelText('规则颜色-0')).toBeInTheDocument();
});
```

- [ ] **Step 2: 跑测试确认红灯**

Run: `pnpm test tests/app/left-panel.test.tsx`

Expected:
- FAIL
- 缺少 `新建方案`、`方案列表`、`规则编辑器` 等元素

- [ ] **Step 3: 实现最小 UI**

左侧面板新增：

- 分类方案列表卡片
- 每行显示：
  - 名称
  - 模式标签
  - 可见开关
  - 设为当前按钮
- 当前方案编辑器
  - `gradient`：名称、最小值、最大值
  - `discrete`：多行 `min/max/color/label`

至少提供以下操作入口：

- `新建方案`
- `复制方案`
- `删除方案`

- [ ] **Step 4: 跑测试确认转绿**

Run: `pnpm test tests/app/left-panel.test.tsx`

Expected:
- PASS

- [ ] **Step 5: 提交这一小步**

```bash
git add tests/app/left-panel.test.tsx src/app/layout/LeftPanel.tsx src/app/styles.css
git commit -m "feat: add classification layer editor panel"
```

---

### Task 4: 地图渲染接入当前可见方案

**Files:**
- Modify: `src/features/map/useMap.ts`
- Modify: `src/features/map/MapView.tsx`
- Modify: `src/shared/geo/raster.ts`
- Test: `tests/app/map-view.test.tsx`
- Test: `tests/geo/raster.test.ts`

- [ ] **Step 1: 写失败测试，覆盖渐变图例和离散图例切换**

```tsx
it('renders a compact NDVI gradient legend for the visible layer', () => {
  render(<MapView />);
  expect(screen.getByLabelText('raster-legend')).toBeInTheDocument();
  expect(screen.getByText('NDVI 默认')).toBeInTheDocument();
});

it('renders discrete legend items for a custom visible layer', () => {
  // 预置 discrete layer
  render(<MapView />);
  expect(screen.getByText('0.70+')).toBeInTheDocument();
});
```

- [ ] **Step 2: 跑测试确认红灯**

Run: `pnpm test tests/app/map-view.test.tsx tests/geo/raster.test.ts`

Expected:
- FAIL
- 图例仍然使用旧的单一列表逻辑，或没有方案名

- [ ] **Step 3: 实现最小地图接线**

`useMap.ts` 需要：

- 读取 `visibleClassificationLayerId`
- 找到当前可见方案
- `gradient` 走连续色带着色
- `discrete` 走规则命中着色
- 更新 `ImageStatic` 的 `url`

`MapView.tsx` 需要：

- 渐变方案显示紧凑色带图例
- 离散方案显示紧凑分段列表
- 图例标题显示当前方案名

- [ ] **Step 4: 跑测试确认转绿**

Run: `pnpm test tests/app/map-view.test.tsx tests/geo/raster.test.ts`

Expected:
- PASS

- [ ] **Step 5: 提交这一小步**

```bash
git add tests/app/map-view.test.tsx tests/geo/raster.test.ts src/features/map/useMap.ts src/features/map/MapView.tsx src/shared/geo/raster.ts
git commit -m "feat: render visible classification layers on the map"
```

---

### Task 5: Hover 命中结果与右侧信息面板

**Files:**
- Modify: `src/features/map/useMap.ts`
- Modify: `src/app/layout/RightPanel.tsx`
- Modify: `src/shared/types/raster.ts`
- Test: `tests/app/right-panel.test.tsx`

- [ ] **Step 1: 写失败测试，覆盖方案名、规则标签、颜色块**

```tsx
it('shows classification layer name, matched label and color chip in hover details', () => {
  render(<RightPanel />);
  expect(screen.getByText('NDVI 默认')).toBeInTheDocument();
  expect(screen.getByText('0.70+')).toBeInTheDocument();
  expect(screen.getByLabelText('像元分级颜色')).toBeInTheDocument();
});
```

- [ ] **Step 2: 跑测试确认红灯**

Run: `pnpm test tests/app/right-panel.test.tsx`

Expected:
- FAIL
- 缺少 `classificationLayerName` 或命中结果字段

- [ ] **Step 3: 实现最小 hover 命中结果**

补充 `RasterHoverInfo`：

- `classificationLayerName`
- `classificationLabel`
- `classificationColor`

`useMap.ts` 在 `pointermove` 中：

- 命中当前可见方案
- 把方案名、标签、颜色写入 `hoverInfo`

`RightPanel.tsx`：

- 展示分类方案
- 展示分级区间
- 展示颜色块

- [ ] **Step 4: 跑测试确认转绿**

Run: `pnpm test tests/app/right-panel.test.tsx`

Expected:
- PASS

- [ ] **Step 5: 提交这一小步**

```bash
git add tests/app/right-panel.test.tsx src/features/map/useMap.ts src/app/layout/RightPanel.tsx src/shared/types/raster.ts
git commit -m "feat: show classification layer hover details"
```

---

### Task 6: 全量验证与收尾

**Files:**
- Modify: `src/app/styles.css`（如图例/列表仍需微调）
- Modify: `src/features/map/debugLogger.ts`（如需补充当前方案摘要）

- [ ] **Step 1: 运行全量测试**

Run: `pnpm test`

Expected:
- PASS
- 所有现有 `GeoTIFF`、围栏、网格测试保持绿色

- [ ] **Step 2: 运行构建**

Run: `pnpm build`

Expected:
- PASS
- 允许保留现有 chunk size warning，只要构建成功即可

- [ ] **Step 3: 手动核对关键交互**

重点确认：

- 上传 `test2.tif` 后默认显示 `NDVI 默认`
- 图例为紧凑渐变色条，不再占大片空间
- 新建离散方案后，`0.7+` 这类规则能实时生效
- 切换可见方案时，地图与 hover 同步切换

- [ ] **Step 4: 记录当前限制**

需要在最终说明里明确：

- 当前着色和 hover 仍基于预览采样值
- 不支持多方案同时叠加混绘
- 不导出带样式的栅格结果

- [ ] **Step 5: 提交最终收尾**

```bash
git add src/app/styles.css src/features/map/debugLogger.ts
git commit -m "chore: polish classification layer UX"
```
