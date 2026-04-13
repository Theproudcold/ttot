# Raster Classification Legend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为单波段 GeoTIFF 预览增加可配置的分级渲染、地图色带图例，以及 hover 的分级区间/颜色信息展示。

**Architecture:** 继续复用现有 `preview.sampleData` 作为前端渲染输入，不改 GeoTIFF 读取主链。新增一组纯函数负责计算有效值范围、分级区间、灰阶颜色和分类后的 RGBA，再把渲染配置存入 `mapUiStore`，由 `useMap` 生成着色后的预览图并同步给 `MapView` / `LeftPanel` / `RightPanel`。

**Tech Stack:** React 19, TypeScript, Zustand, OpenLayers, Vitest, Testing Library

---

### Task 1: 分级纯函数与类型

**Files:**
- Modify: `src/shared/types/raster.ts`
- Modify: `src/shared/geo/raster.ts`
- Test: `tests/geo/raster.test.ts`

- [ ] **Step 1: 写失败测试**
- [ ] **Step 2: 跑测试确认确实按预期失败**
- [ ] **Step 3: 实现最小分级计算与着色逻辑**
- [ ] **Step 4: 重新跑测试确认转绿**

### Task 2: 渲染配置状态与参数面板

**Files:**
- Modify: `src/features/map/mapUiStore.ts`
- Modify: `src/app/layout/LeftPanel.tsx`
- Test: `tests/features/map-ui-store.test.ts`
- Test: `tests/app/left-panel.test.tsx`

- [ ] **Step 1: 写失败测试**
- [ ] **Step 2: 跑测试确认失败点是缺少分级状态/控件**
- [ ] **Step 3: 实现最小状态和输入控件**
- [ ] **Step 4: 重新跑测试确认转绿**

### Task 3: 地图图例与 hover 分级信息

**Files:**
- Modify: `src/features/map/useMap.ts`
- Modify: `src/features/map/MapView.tsx`
- Modify: `src/app/layout/RightPanel.tsx`
- Modify: `src/app/styles.css`
- Test: `tests/app/map-view.test.tsx`
- Test: `tests/app/right-panel.test.tsx`

- [ ] **Step 1: 写失败测试**
- [ ] **Step 2: 跑测试确认失败点是缺少图例/hover 分级展示**
- [ ] **Step 3: 实现最小 UI 和着色接线**
- [ ] **Step 4: 重新跑测试确认转绿**

### Task 4: 总体验证

**Files:**
- Modify: `src/features/map/debugLogger.ts`（如需要补调试摘要）

- [ ] **Step 1: 跑 `pnpm test`**
- [ ] **Step 2: 跑 `pnpm build`**
- [ ] **Step 3: 记录剩余限制，尤其是 hover 当前仍基于预览采样值**
