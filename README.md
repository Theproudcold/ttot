# GeoTIFF 围栏网格工具

一个面向内部专业人员的桌面端网页工具骨架，目标是支持：

- 读取并展示 `GeoTIFF`
- 绘制和编辑电子围栏
- 按真实尺寸实时预览网格
- 导出围栏和网格 `GeoJSON`

## 当前进度

- 已初始化 `Vite + React + TypeScript + Vitest`
- 已搭好三栏工作台骨架
- 已补上基础 CRS / 网格预估工具与测试

## 启动

```bash
pnpm install
pnpm dev
```

## 测试

```bash
pnpm test
```

## 下一步

- 接入 `GeoTIFF` 元信息读取
- 挂载 `OpenLayers` 地图实例
- 实现单围栏绘制与实时网格预览
