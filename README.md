# GeoTIFF 围栏网格工具

一款面向专业人员的桌面端 Web 工具，用于加载、分析和处理 GeoTIFF 遥感影像。通过交互式地图，用户可以可视化影像数据、绘制电子围栏、生成空间网格，并完成网格均值聚合、分类渲染与精确裁剪导出。

## 核心特性

- **GeoTIFF 加载与解析**
  - 支持本地读取大尺寸 GeoTIFF 文件
  - 自动提取 CRS、分辨率、边界框等元信息
  - 分阶段加载：优先显示影像预览，后台异步提取有效数据区域（nodata mask）

- **电子围栏绘制与编辑**
  - 在地图上自由绘制多边形围栏
  - 围栏自动裁剪到影像边界和有效数据范围内
  - 支持导出为 GeoJSON

- **空间网格预览与聚合**
  - 根据围栏物理尺寸实时划分网格
  - 支持自定义网格尺寸和旋转角度
  - 基于影像分辨率自动限制最小网格尺寸，防止过密划分
  - 超大网格几何预览采样（50k 单元格上限），防止浏览器渲染崩溃
  - 按命中网格统计主波段有效像元均值
  - 网格预览、Hover 信息与导出结果保持一致

- **后台计算加速（Web Worker）**
  - 栅格预览重着色、有效数据掩码生成、网格聚合计算 offload 到后台线程
  - 避免大文件处理时阻塞主线程，保持地图交互流畅
  - 主线程自动降级兜底，确保兼容性

- **栅格分类图层渲染**
  - 针对单波段影像提供分类渲染（规则模式 / 渐变色模式）
  - 地图上实时预览分类着色结果
  - 支持自定义分类规则、颜色、标签与处方用量估算

- **数据导出**
  - **GeoJSON**：导出围栏、网格几何及聚合属性
  - **GeoTIFF**：基于围栏裁剪原始影像，将网格聚合值写入对应像元，未命中区域填充 NoData

## 技术栈

- **框架** / React 19 + TypeScript + Vite
- **状态管理** / Zustand
- **地图渲染** / OpenLayers 10 + geotiff.js
- **空间计算** / Turf.js + Proj4js
- **测试** / Vitest + Testing Library

## 项目结构

```text
src/
├── app/
│   ├── layout/               # 三栏布局 (TopBar, LeftPanel, RightPanel)
│   │   └── right-panel/      # 右侧面板子模块（分类渲染、Hover 信息、输入控件）
│   ├── styles/               # 全局与布局样式 (base / layout / components)
│   ├── App.tsx               # 应用根组件
│   └── main.tsx              # 渲染入口
├── features/
│   ├── map/                  # 地图、栅格图层、加载器、交互钩子
│   ├── grid/                 # 网格状态与预览逻辑
│   ├── fence/                # 围栏绘制、编辑与校验
│   ├── export/               # GeoJSON / GeoTIFF 导出链路
│   └── loading/              # 全局加载状态
├── shared/
│   ├── geo/                  # 地理空间计算
│   │   ├── crs.ts            # 坐标系检测与投影转换
│   │   ├── fence.ts          # 围栏裁剪与校验
│   │   ├── grid.ts           # 网格生成
│   │   ├── gridAggregation.ts# 网格像元聚合
│   │   ├── geotiffExport.ts  # GeoTIFF 导出
│   │   ├── geotiffWriter.ts  # GeoTIFF 写入器
│   │   ├── raster*.ts        # 栅格解析、分类、颜色、IO、预览
│   │   └── metricTransform.ts# 度量空间变换
│   ├── hooks/                # 通用 React Hooks
│   ├── types/                # 全局类型定义
│   └── utils/                # 工具函数
tests/                        # 单元测试与组件测试
docs/superpowers/             # 设计与实现方案文档
```

## 快速启动

依赖环境：Node.js 18+，pnpm

```bash
# 安装依赖
pnpm install

# 启动开发服务器
pnpm dev
```

默认访问 `http://localhost:5173`。

## 测试

```bash
# 运行所有测试
pnpm test
```

## 开发路线

### 已完成功能
- [x] Vite + React + TypeScript + Vitest 基础架构
- [x] 三栏工作台布局与地图集成
- [x] GeoTIFF 读取、元信息解析与 OpenLayers 渲染
- [x] 围栏绘制、编辑、裁剪与 GeoJSON 导出
- [x] 空间网格实时预览与聚合分析
- [x] 栅格分类图层（规则/渐变）与处方用量估算
- [x] 网格均值聚合统一驱动地图预览与 GeoTIFF 导出
- [x] 多坐标系检测与投影转换
- [x] 网格旋转控制与围栏裁剪
- [x] RasterSession 复用（减少重复读取开销）
- [x] 地图 Hover 计算开销优化（rAF 节流、Zustand subscribe 统一同步）
- [x] 渲染性能优化 Phase 1
  - 指针移动 rAF 节流、O(1) 网格空间查找
  - 网格样式缓存与 OpenLayers 批量渲染（`addFeatures`）
  - 超大网格几何预览采样上限（50k cells）
  - 右侧面板规则统计 `useMemo` 缓存
- [x] Web Worker 后台计算（栅格预览、掩码、网格聚合 offload 主线程）
- [x] 基于影像分辨率的最小网格尺寸限制

### 进行中 / 计划
- [ ] 多围栏队列管理与批量导出
- [ ] 大型文件分块提取与内存优化
