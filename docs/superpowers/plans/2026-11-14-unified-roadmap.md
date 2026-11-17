# 统一推进排期（状态往返 + 竞品差距）

> 合并两条工作流：R = 状态往返（round-trip），G = 竞品差距补齐。
> 约束：单人开发，无后端，不引入新运行时依赖（除非单一目标明确要求）。
> 日期：2026-11-14

## 0. 两个 MVP 定义（先确定目标再排期）

| 代号 | 目标 | 必须完成 | 完成后的东西 |
| --- | --- | --- | --- |
| **MVP-A** | 自用 / 交付客户 | M0 + M1 + M2 | 产物能被农机或 GIS 读取、设置能保存还原的可用工具 |
| **MVP-B** | 开源被采用 | M0 + M1 + M4 | 一个"矩形栅格处方生成器"，与矢量/ISOXML 类工具互补 |

M0 是共同前置；M3 与 M5 是可选增强，不阻塞任一 MVP。

## 1. 里程碑与依赖

```
M0 地基 ──┬─→ M1 状态可还原 ──→ M4 单文件往返 + 栅格处方做深   (MVP-B)
          │                    ↗
          └─→ M2 处方语义 ────┘
                   ↓
              M3 指数与分区        (与 M1/M2 无依赖，可并行)
                   ↓
              M5 采用门槛收口      (依赖 M0；其余不阻塞)
```

- **M0 → M1**：无 M0 的构建修复，后续无法验证。
- **M1 → M4**：M4 的内嵌配方复用 M1 的 `ProjectSnapshot` 契约。
- **M2 独立于 M1**：处方语义改造不依赖快照，可先做。
- **M3 独立**：植被指数与分区分析与前两者正交。

## 2. M0 地基与可交付

| ID | 任务 | 改动点 | 验收 |
| --- | --- | --- | --- |
| R0-1 | 修 `metricTransform` 类型错误，恢复 `pnpm build` | `src/features/map/useMap.ts:691,694`、`src/shared/types/grid.ts:39-44`、`src/shared/geo/grid.ts:157-174` | `npx tsc -p tsconfig.app.json` 退出码 0 |
| R0-2 | 加 `LICENSE`(MIT) 与 CI（`test` + `build`） | 新增 `LICENSE`、`.github/workflows/ci.yml`；`package.json` 补 `license`/`description` | CI 在 push 上跑绿 |
| R0-3 | 修整数栅格导出数值损坏 + 多波段被主波段覆盖 | `src/features/export/exportGeoTiff.ts:101-137`、`src/shared/geo/gridAggregation.ts:664-694` | Uint16 影像导出的均值不再被截断；多波段语义有明确决策 |
| R0-4 | 修 nodata 哨兵碰撞（E1） | `src/shared/geo/geotiffExport.ts:574-595` | 均值为 0 的 cell 在往返后不丢失 |

**M0 出口标准**：`pnpm test` 与 `pnpm build` 双绿；CI 生效；导出数值正确性有回归测试。

## 3. M1 状态可还原（round-trip 核心）

| ID | 任务 | 依赖 |
| --- | --- | --- |
| R1-1 | `ProjectSnapshotV1` + 校验器 + 序列化/迁移 | R0-1 |
| R1-2 | `exportProjectSnapshot` / `toStorePatches` / `applyStorePatches`（纯函数分层） | R1-1 |
| R1-3 | `gridStore.restoreGrid`、`mapUiStore.restoreUiState`（原子写入） | R1-1 |
| R1-4 | 顶栏「保存工程 / 打开工程」(`.ttot.json`) | R1-2 |
| R1-5 | 移除 `LeftPanel` 无条件 `reset*`，改为调用方决定 | R0-1 |
| R1-6 | 指纹比较（`name+size+lastModified`）+ CRS/范围一致性校验与提示 | R1-1 |
| R1-7 | localStorage 自动草稿 + 启动恢复提示 | R1-2 |

**M1 出口标准**：纯函数往返深比较通过；刷新后草稿可恢复；无配方的第三方 TIFF 行为不变（回归）。

详细契约见 `docs/superpowers/specs/2026-11-14-project-roundtrip-design.md`。

## 4. M2 处方语义正确（领域正确性）

| ID | 任务 | 说明 |
| --- | --- | --- |
| G2-1 | **速率模型改造** | `applicationRate` 从"单格用量"改为**单位面积速率 + 单位**（m² / ha / 亩）；总量 = 速率 × 面积。涉及 `src/shared/types/raster.ts:39-45`、`src/app/layout/right-panel/RightPanel.tsx:117-121,393`、两处导出 |
| G2-2 | **Shapefile 导出** | 纯前端写 `.shp/.shx/.dbf` 并打包 zip；可参考 shp-write 的实现思路，或自行实现最小 writer |
| G2-3 | **ISOXML（ISO 11783-10）导出** | `TASKDATA.XML` + `GRD` 二进制网格 + zip；优先复用 [isoxml-js](https://github.com/dev4Agriculture/isoxml-js) 的数据模型 |
| G2-4 | 分区统计表补列 | 均值 / 面积(ha、亩) / 速率 / 用量 / 成本，对齐 Metashape 的分区表基线 |

**M2 出口标准**：导出的 Shapefile 能在 QGIS 打开；ISOXML 能被 [isoxml-py](https://github.com/Josephinum-Research/isoxml-py) 解析通过；分区表以公顷与单位面积速率显示。

> G2-3 是本项目**最大的落地缺口**，也是最容易被低估的工作量（XML 绑定 + GRD 二进制网格 + zip 打包）。

## 5. M3 指数与分区（与 M1/M2 并行）

| ID | 任务 | 说明 |
| --- | --- | --- |
| G3-1 | 植被指数计算 | NDVI/GNDVI/NDRE/SAVI/EVI，最少 5 个；纯函数 + 测试 |
| G3-2 | 自动波段识别 | 波长元数据 → DJI 波段名 → ODM 约定 → 反射率启发式，逐级回退 + 手动覆盖 |
| G3-3 | 直方图 + 等面积自动分级 | 直方图 UI + "按等面积切 N 级"一键生成规则 |
| G3-4 | 行向对齐 | 从网格方向升级为"农机作业方向"，含最长边自动推荐 |

**M3 出口标准**：用样例多光谱影像一键算出 NDVI 并等面积分 5 级，且分级结果与直方图一致。

## 6. M4 单文件往返 + 栅格处方做深（护城河）

| ID | 任务 | 依赖 |
| --- | --- | --- |
| R4-1 | writer 支持 `imageDescription`（tag 270） | R0-2 |
| R4-2 | 导出 GeoTIFF 内嵌配方（`TTOT1:` 前缀 + base64，32KB 上限） | R1-1, R4-1 |
| R4-3 | 导入探测与还原（含源文件缺失/指纹不匹配分支） | R4-2, R1-6 |
| R4-4 | 修处方波段导致的分类门限失效（`sampleBandCount === 1`） | R0-3 |
| R4-5 | GeoJSON 内嵌 `ttot:project` + 独立 GeoJSON 输入通道 + `rotationDeg` 落盘 | R1-1 |
| G4-1 | 多波段处方：逐波段聚合或明确声明只支持主波段 | R0-3 |
| G4-2 | 逐像元速率写入（而非整格同一速率）+ 与 ISOXML 双出口一致性校验 | G2-1, G2-3 |

**M4 出口标准**：幂等测试通过（导出 → 导入 → 再导出，像素级一致，含 nodata=0 碰撞用例）；rules 模式往返后视觉与数值一致。

## 7. M5 采用门槛收口

| ID | 任务 | 说明 |
| --- | --- | --- |
| G5-1 | 免构建产物 | 提交 prebuilt 静态产物或提供一键部署（GitHub Pages） |
| G5-2 | 英文 README + 截图 + 演示 GIF | 明确写出"栅格处方生成器"的差异化定位 |
| G5-3 | i18n（zh / en） | 参考 NDVItoTaskmap 的 NL/EN 做法 |
| G5-4 | 用户文档 | 与开发者 spec 分离的面向用户手册 |
| G5-5 | 清理技术债 | ✅ 已完成（2026-11-17，分支 `remove-historical-baggage`）。原清单四项全部处理：`grid.ts` 的 `buildCellPolygon` 与多参数兼容层（含 `resolveMetricTransform`）已删；`LeftPanel` 与 `classificationUtils` 的重复函数已收敛为单一实现；`tests/tmp-displayvalue.test.tsx` 已删；pnpm-store 符号链接本就未入库，`.gitignore` 已补 `.agents/`。另清出：孤儿模块 `rowDirection.ts`、被 `gridLookup` 取代的命中测试器、只写不读的 `rasterRenderSettings` 整条链路、只存在于当日中间态的草稿兼容读取、同值的规则边界双常量、分叉的 Worker 请求管线。CI 增加 `--noUnusedLocals` 守门。 |

> 原 G5-5 的措辞有一处会误导执行者：它把 `grid.ts` 的 `resolveMetricTransform` 记为死代码，但
> `gridAggregation.ts` 与 `geotiffExport.ts` 中**同名且仍在被调用**的两份拷贝必须保留。同名不同命，
> 按文件名搜删除目标会误伤。本次已按调用图逐个核对后再删。

## 8. 建议执行顺序（单人）

| 顺序 | 里程碑 | 工作量估计 | 理由 |
| --- | --- | --- | --- |
| 1 | **M0** | 0.5–1 天 | 前置；不修构建则无法验证任何后续改动 |
| 2 | **M1** | 2–3 天 | 直接兑现用户原始诉求（导出后能还原），投入产出比最高 |
| 3 | **M2** | 3–5 天 | 决定产物能否被下游使用；G2-3 单独占一半以上 |
| 4 | **M3** | 2–3 天 | 让"NDVI 处方"名实相符 |
| 5 | **M4** | 1.5–2.5 天 | 兑现"重新导入导出的文件即还原"+ 建立差异化 |
| 6 | **M5** | 1–2 天 | 采用门槛，成本最低 |

合计约 10–17 人日。若只做 MVP-A，取 1→2→3（约 6–9 天）；若只做 MVP-B，取 1→2→5（约 4–6.5 天）。

## 9. 风险登记

| # | 风险 | 应对 |
| --- | --- | --- |
| K1 | G2-3 ISOXML 工作量被低估 | 先做 spike：用 isoxml-py 生成一个最小 TASKDATA 样本并逐字段对齐；确认 GRD 网格编码细节后再排期 |
| K2 | G2-1 速率模型改造会改变导出字段语义 | 与 R1-1 的快照版本号一起处理；导出字段加 `version`，旧文件按 v1 语义读取 |
| K3 | G3-2 自动波段识别依赖影像元数据质量 | 保留手动覆盖入口；无元数据时明确提示而非猜测 |
| K4 | M4 内嵌配方占用 `ImageDescription` | 已在 round-trip 设计 §17 U1 登记；用 `TTOT1:` 前缀避免误读 |
| K5 | 补齐后仍无采用 | 见 `docs/superpowers/specs/2026-11-14-competitive-gap-analysis.md` §4：即使追平，同 niche 领导者亦仅 3 star，需以差异化定位而非功能追平取胜 |
