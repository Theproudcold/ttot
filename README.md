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

- **栅格分类图层渲染与施肥量配置**
  - 针对单波段影像提供分类渲染（规则模式 / 渐变色模式）
  - 地图上实时预览分类着色结果
  - 支持自定义分类规则、颜色、标签与施药/施肥用量（applicationRate）
  - 导出时将分类对应的施肥量一并写入 GeoJSON 属性与 GeoTIFF 附加波段

- **数据导出**
  - **GeoJSON**：导出围栏、网格几何及聚合属性；若配置了分类规则的施肥量（`applicationRate`），该值会作为 `fertilizerAmount` 写入每个网格单元的 `properties`
  - **GeoTIFF**：基于围栏裁剪原始影像，将网格聚合值写入对应像元，未命中区域填充 NoData。当启用了分类规则时，所有波段强制转换为 `Float32`，并额外追加一个 `Float32` 波段存储每个像元匹配规则的施肥量（`applicationRate`），便于下游处方机读取

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

## 功能模块介绍

### 1. 栅格文件接入模块
- **职责**：负责 GeoTIFF 文件选择、元信息解析、预览图生成和有效区域提取，是整条业务链路的入口。
- **核心能力**：
  - 读取文件名、尺寸、CRS、像元大小、边界框等基础信息
  - 先生成预览图，后异步提取有效数据掩码，缩短首屏等待时间
  - 维护读取进度、加载阶段、异常状态与指针坐标显示
- **对应实现**：
  - `src/features/map/rasterStore.ts`
  - `src/features/map/useRasterLoader.ts`
  - `src/shared/geo/rasterIo.ts`
  - `src/shared/geo/rasterPreview.ts`

### 2. 地图工作区模块
- **职责**：负责地图实例创建、图层渲染、视口适配和鼠标悬停反馈，是用户的核心交互区。
- **核心能力**：
  - 使用 OpenLayers 渲染影像、围栏和网格图层
  - 提供“适配影像 / 适配围栏”视图定位
  - 实时展示悬停坐标、像元值、分类结果、命中网格等信息
  - 支持分类图例展示与图层显隐控制
- **对应实现**：
  - `src/features/map/MapView.tsx`
  - `src/features/map/useMap.ts`
  - `src/features/map/mapUiStore.ts`
  - `src/features/map/mapUtils.ts`

### 3. 围栏绘制与裁剪模块
- **职责**：负责围栏绘制、编辑、校验、摘要统计与边界裁剪，确保后续分析范围准确。
- **核心能力**：
  - 支持地图上绘制和编辑多边形围栏
  - 计算围栏面积、边界框、顶点数等摘要信息
  - 将围栏裁剪到影像边界或有效数据区域内
  - 为点选命中、导出边界和网格生成提供统一空间范围
- **对应实现**：
  - `src/features/fence/fenceStore.ts`
  - `src/shared/geo/fence.ts`

### 4. 网格生成与聚合分析模块
- **职责**：负责按围栏范围生成网格，并对网格内像元执行聚合计算，是项目的分析核心。
- **核心能力**：
  - 支持自定义网格尺寸、旋转角度和聚合模式
  - 根据围栏中心命中规则筛选有效网格
  - 按网格统计像元均值、有效像元数量等结果
  - 超大网格仅做采样预览，避免地图渲染过载
- **对应实现**：
  - `src/features/grid/gridStore.ts`
  - `src/shared/geo/grid.ts`
  - `src/shared/geo/gridAggregation.ts`
  - `src/shared/geo/gridLookup.ts`

### 5. 分类渲染与处方配置模块
- **职责**：负责单波段影像的分类着色、规则配置和施肥/施药量映射，支撑可视化表达与处方数据输出。
- **核心能力**：
  - 支持渐变色和规则分段两种分类模式
  - 支持多套分类方案的新建、复制、切换和显示控制
  - 可为规则配置颜色、标签和 `applicationRate`
  - 根据分类结果汇总覆盖面积与预计总用量
- **对应实现**：
  - `src/features/map/mapUiStore.ts`
  - `src/app/layout/RightPanel.tsx`
  - `src/app/layout/right-panel/classificationUtils.ts`
  - `src/shared/geo/rasterClassification.ts`

### 6. 导出模块
- **职责**：负责将围栏、网格和裁剪后的分析结果输出为标准地理数据文件，打通结果落地链路。
- **核心能力**：
  - 导出围栏 GeoJSON
  - 导出包含聚合值和施肥量字段的网格 GeoJSON
  - 导出围栏裁剪后的 GeoTIFF，并按网格聚合结果回写像元
  - 在规则分类模式下追加处方波段，供下游设备读取
- **对应实现**：
  - `src/features/export/exportGeoJson.ts`
  - `src/features/export/exportGeoTiff.ts`
  - `src/shared/geo/geotiffExport.ts`
  - `src/shared/geo/geotiffWriter.ts`

### 7. 后台计算与性能保障模块
- **职责**：负责把重计算任务搬到后台线程，并通过缓存与节流策略控制前端性能风险。
- **核心能力**：
  - 将预览生成、有效区域提取、网格聚合等任务下沉到 Web Worker
  - Worker 不可用时自动回退主线程执行
  - 使用 rAF 节流、样式缓存、空间索引等手段降低交互开销
  - 保证大尺寸影像和高密度网格场景下的可用性
- **对应实现**：
  - `src/shared/workers/rasterCompute.worker.ts`
  - `src/features/map/useRasterLoader.ts`
  - `src/features/map/useMap.ts`
  - `src/features/map/debugLogger.ts`

### 8. 界面编排与全局状态模块
- **职责**：负责三栏工作台布局、顶层操作编排、加载提示和全局状态衔接，串起所有业务模块。
- **核心能力**：
  - 左侧面板承载文件、围栏和网格参数配置
  - 中间地图工作区承载影像与空间结果可视化
  - 右侧面板承载结果统计、图层控制、悬停信息和分类方案配置
  - 顶栏统一提供围栏、网格、GeoTIFF 导出入口
- **对应实现**：
  - `src/app/App.tsx`
  - `src/app/layout/TopBar.tsx`
  - `src/app/layout/LeftPanel.tsx`
  - `src/app/layout/RightPanel.tsx`
  - `src/features/loading/loadingStore.ts`

## 典型业务流程

1. 用户在左侧面板选择 GeoTIFF 文件，系统解析元信息并生成地图预览。
2. 用户在地图上绘制或编辑围栏，围栏结果写入全局状态并同步展示摘要。
3. 用户配置网格尺寸、旋转角度和分类方案，系统生成网格预览并完成像元聚合。
4. 地图与右侧面板同步展示网格统计、分类结果和处方量估算。
5. 用户通过顶栏导出围栏 GeoJSON、网格 GeoJSON 或裁剪后的 GeoTIFF 结果。

## 模块关系说明

- `app`：负责页面布局和交互入口编排。
- `features`：负责具体业务模块的状态与流程控制。
- `shared/geo`：负责地理空间计算、GeoTIFF 处理和分类算法，是底层能力层。
- `shared/types`：定义围栏、网格、栅格等核心数据结构，统一模块间的数据契约。
- `tests`：覆盖导出、空间计算、状态管理和主要界面交互，保证模块协同不跑偏。

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
- [x] 栅格分类图层（规则/渐变）与施肥量/施药量估算
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
