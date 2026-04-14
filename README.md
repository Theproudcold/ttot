# 🌍 GeoTIFF 围栏网格工具 (GeoTIFF Fence Grid Tool)

这是一个专为内部专业人员打造的桌面端 Web 工具。它旨在提供一个高效且直观的工作流，用于加载、分析和处理大尺寸 GeoTIFF 数据。通过所见即所得的操作界面，用户可以轻松绘制电子围栏、预览空间网格，并支持局部数据的精确裁剪与导出。

## ✨ 核心特性

- **🗺️ GeoTIFF 图像加载与解析**：支持加载包含地理空间信息的 GeoTIFF 文件，并在 `OpenLayers` 实例中进行渲染。
- **🖍️ 电子围栏绘制**：提供直观的交互工具，让用户在地图上自由绘制和编辑多边形围栏区域，并支持保存为标准 `GeoJSON`。
- **📏 实时网格分析与导出**：
  - 基于当前围栏区域的真实物理尺寸实时预览网格划分。
  - 支持将网格分析结果统一聚合并导出为 `GeoJSON` 文件。
- **✂️ 数据蒙版与裁剪**：支持基于用户圈定的围栏生成蒙版，精确裁切原始 GeoTIFF 数据，可作为全新文件导出供下游系统使用。
- **🎨 现代化 UI 与用户体验**：
  - 采用基于 “毛玻璃” (Glassmorphism) 的现代化暗黑/亮色UI组件设计，提升专业工具的视觉美感。
  - 全局集成 `AlertOverlay` 警告管控系统，无缝处理异常提示与用户反馈。

## 🛠 技术栈

采用主流且高性能的前端技术栈构建：

- **核心框架** / `React 19` + `TypeScript` + `Vite`
- **状态管理** / `Zustand`
- **空间计算分析** / `Turf.js` + `Proj4js`
- **地图与像素渲染** / `OpenLayers (ol)` + `geotiff.js`
- **测试框架** / `Vitest` + `Testing Library`

## 📂 项目结构

```text
src/
├── app/        # 应用核心与整体布局 (AppShell, AlertOverlay, RightPanel/LeftPanel)
├── features/   # 核心业务模块 (如: 地图 MapView、栅格图层处理、绘制工具等)
├── shared/     # 共享基础库 (类型定义、工具函数、Store 初始化等)
└── main.tsx    # 渲染入口
```

## 🚀 快速启动

前提条件：请确保您的环境中已安装 [Node.js](https://nodejs.org/) (建议基于 `v18+`) 与 [pnpm](https://pnpm.io/)。

1. **安装依赖**
   ```bash
   pnpm install
   ```

2. **启动开发服务器**
   ```bash
   pnpm dev
   ```
   > 正常运行后，使用浏览器访问控制台中显示的本地端口 (默认 `http://localhost:5173`) 即可体验。

## 🧪 测试

项目包含完整的单元测试与组件测试环境。

- 运行所有测试用例：
  ```bash
  pnpm test
  ```

## 🗓 开发路线图 (Roadmap)

### 已完成里程碑
- [x] 初始化 Vite + React + TypeScript + Vitest 基础架构
- [x] 搭建完成三栏工作台骨架及现代化排版体系
- [x] GeoTIFF 读取解析与 OpenLayers 地图挂载展示
- [x] 地图核心交互：单体围栏绘制与编辑
- [x] 实时网格分析预览及其聚合 GeoJSON 导出能力
- [x] 面向多边形围栏的结构裁剪及 GeoTIFF 下载链路
- [x] 完善系统级 Toast 和告警机制

### 待做与进行中 (Todo)
- [ ] 支持多条围栏队列管理与批量导出功能
- [ ] 提供更细粒度的栅格分类图层渲染规则配置面板
- [ ] 优化大型 GeoTIFF 文件渲染的内存占用率与分片提取性能
- [ ] 增强多坐标系 (CRS) 检测和投影无缝转换支持
