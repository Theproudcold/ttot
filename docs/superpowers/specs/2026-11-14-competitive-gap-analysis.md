# 竞品差距分析

> 状态：调研结论归档。ttot 列全部在仓库代码中核实；竞品列来自各自官方文档 / 仓库 / 插件索引。
> 日期：2026-11-14

## 1. 竞品集合

| 类别 | 代表 | 关键事实 |
| --- | --- | --- |
| 最接近的开源同类 | [NDVItoTaskmap](https://github.com/HASUniversity/NDVItoTaskmap)（HAS University，MIT） | 浏览器内 GeoTIFF → 变量作业图；20+ 植被指数、自动波段识别、等面积自动分级、直方图、行向对齐、地块边界（PDOK/BRP）、ISOXML/Shapefile/GeoJSON/CSV 四种出口、免构建、NL/EN 双语。2026-03 建仓、2026-10 仍活跃、**3 star / 1 fork** |
| 开源 GIS 插件 | [QGIS CropSense](https://plugins.qgis.org/plugins/CropSense/) | 22+ 植被指数，支持分离波段 TIF 与堆叠多波段 GeoTIFF，含自定义指数公式构建器 |
| 无人机处理软件内建 | [Agisoft Metashape](https://agisoft.freshdesk.com/support/solutions/articles/31000161545-prescription-maps-generation-in-agisoft-metashape)、[PIX4Dfields](https://support.pix4d.com/hc/en-us/articles/360000899466) | 直方图 + 分级断点标注 + 分区表，列为 `Zonal mean` / `Area (ha)` / `Rate (kg/…)` |
| 商业 SaaS | [GeoPard](https://geopard.tech/management-zones-vra-maps/) | 管理分区、按农业投入品设费率并算成本、多图层（产量/土壤/EC/多年）、直推 [John Deere Operations Center / CNH / Trimble](https://docs.geopard.tech/geopard-tutorials/product-tour-web-app/john-deere-operations-center-integration/9.-export-soil-topography-satellite-or-analytics-as-map-layers) |
| 下游消费端（开源） | [AgOpenGPS](https://docs.agopengps.com/) Rate Control | 变量速率 + 分控；ISOXML 生态已有 [isoxml-js](https://github.com/dev4Agriculture/isoxml-js) 与 [isoxml-py](https://github.com/Josephinum-Research/isoxml-py) 可复用 |
| 相关工具 | [NFert `export_prescription`](https://mcroci.github.io/NFert/reference/export_prescription.html)（shp/geojson/kml/gpkg）、[fieldmargin 地块上传](https://support.fieldmargin.com/en/articles/1869631-upload-shape-files-or-kml-files-to-create-field-boundaries)、[ReviveAg 处方查看器](https://www.reviveag.farm/tools/isoxml-shapefile-viewer)、[Develop with Deere Rx 文档](https://developer.deere.com/dev-docs/files) | 说明「单位面积速率 + Shapefile/ISOXML」是该领域的通行契约 |

## 2. 差距矩阵

严重度：🔴 阻断落地 ｜ 🟠 业务认知/正确性 ｜ 🟡 采用门槛 ｜ 🟢 已有优势

### 2.1 输出与互操作（决定"能不能落地"）

| 能力 | 竞品基线 | ttot | 等级 |
| --- | --- | --- | --- |
| 单位面积速率模型（kg/ha、L/ha、kg/亩） | Metashape 分区表即 `Rate (kg/…)` + `Area (ha)` | ❌ `applicationRate` 语义为"单格用药量"（`src/app/layout/right-panel/RightPanel.tsx:393`），总量 = 速率 × 格数（同文件 `117-121`），且**无单位字段** | 🔴 |
| ISOXML（ISO 11783-10 TaskData） | NDVItoTaskmap ✅；AgOpenGPS 直读 | ❌ 全仓无 `isoxml` | 🔴 |
| Shapefile | 几乎所有；JD Ops Center / Trimble / CNH 均支持 | ❌ | 🔴 |
| KML/KMZ、CSV、GeoPackage | NFert 四种全给；NDVItoTaskmap 有 CSV | ❌ 仅 GeoJSON + GeoTIFF | 🟠 |
| 处方栅格 + 附加 Float32 处方波段 | 竞品清一色矢量输出 | ✅ **独有** | 🟢 |
| 直推 FMIS API | GeoPard ✅ | ❌ | 🟡 |
| 处方校验（终端视角预览） | ReviveAg 专做 | ❌ | 🟡 |

### 2.2 输入与栅格语义（决定"喂进去的是什么"）

| 能力 | 竞品基线 | ttot | 等级 |
| --- | --- | --- | --- |
| 植被指数计算（NDVI/GNDVI/NDRE/SAVI/EVI/MCARI…） | CropSense 22+、NDVItoTaskmap 20+ | ❌ **完全没有**。`buildDefaultNdviClassificationLayer`（`src/shared/geo/rasterClassification.ts:159-168`）只返回色带定义；所谓"NDVI 默认分级"实为对主波段原始值套渐变 | 🔴 |
| 自动波段识别（波长元数据 / DJI 波段名 / ODM 约定 / 反射率启发式） | NDVItoTaskmap ✅ | ❌ 不读波长与波段名，按样本索引取前 3 波段 | 🔴 |
| 调色板 / Alpha / ExtraSamples 语义 | 普遍 | ❌ 忽略调色板；仅在写处方波段时写 ExtraSamples（`src/shared/geo/geotiffWriter.ts:286`） | 🟡 |
| 地块边界文件导入（Shapefile/KML/GeoJSON） | fieldmargin / GeoPard | ❌ 仅手绘围栏 | 🟠 |
| COG / 远端范围懒加载 | NDVItoTaskmap "overview-aware lazy reading" | ❌ 全量读取（42MB 影像被读 3 遍）；`rasterIo` 有 URL/fetch 代码路径但无 UI 入口 | 🟡 |
| 拍照式 RGB 图导出（DJI Plant Health 代理 NDVI） | NDVItoTaskmap ✅ | ❌ | 🟡 |

### 2.3 分析与分区（决定"是不是一个 VRA 工具"）

| 能力 | 竞品基线 | ttot | 等级 |
| --- | --- | --- | --- |
| 直方图 + 分级断点可视化 | Metashape 明确有 | ❌ 仅一句文字范围提示 | 🟠 |
| 等面积自动分级 | NDVItoTaskmap / Metashape ✅ | ❌ 全手工规则 | 🟠 |
| 分区统计表（均值 / 面积 ha / 用量） | Metashape 即此三列 | 🟠 部分：有命中数/面积/用量，但单位与速率语义同上表首条 | 🟠 |
| 管理分区聚类、多图层叠加（产量/土壤/EC/多年） | GeoPard ✅ | ❌ 单栅格单方案 | 🟠 |
| 自定义指数公式 | CropSense ✅ | ❌ | 🟡 |
| 行向对齐（农机作业方向） | NDVItoTaskmap ✅ | ❌ 有 `rotation`，但语义是网格方向 | 🟠 |

### 2.4 工程与采用门槛

| 能力 | 竞品基线 | ttot | 等级 |
| --- | --- | --- | --- |
| License | NDVItoTaskmap MIT | ❌ 无 LICENSE，`package.json` 为 `private: true` | 🟡 |
| 可构建 | —— | ❌ `pnpm build` 失败 | 🟡 |
| 免构建部署（clone + 静态服务即用） | NDVItoTaskmap ✅ | ❌ 需 Node 22 + pnpm + Vite | 🟡 |
| i18n | NDVItoTaskmap NL/EN | ❌ 中文单语 | 🟡 |
| 用户文档 / 截图 / demo 站 | 普遍具备 | ❌ 仅开发者 spec | 🟡 |
| 数值正确性 | —— | ❌ 整数栅格截断、多波段被主波段覆盖、nodata 碰撞、南向上窗口退化 | 🔴 对自身 |
| 测试与 CI | —— | 🟡 167 个测试是相对优势，但无 CI，Worker 路径零覆盖 | 🟡 |

## 3. 我们仅存的四项优势

1. **矩形栅格处方输出**：手写 TIFF writer 把网格聚合值写回像元，并附加一个 Float32 处方波段——竞品清一色输出矢量，这是唯一不撞车的资产。
2. **裁剪到有效数据区**（`src/shared/geo/fence.ts:337-549`）：有效像元轮廓追踪 + Douglas-Peucker 简化，比多数脚本只裁 bbox 认真。
3. **统一退化米制变换**（`src/shared/geo/metricTransform.ts`）+ 旋转网格，使"以米为单位的网格"在投影与地理 CRS 下语义一致。
4. 分层架构 + 167 个测试（在本 niche 内不常见）。

## 4. 结论与路线选择

**定性**：缺的不是"几个功能"，而是**从"栅格查看器 + 网格统计"到"处方生成器"的整条领域链**。竞品在这条链上领先一个量级；ttot 在链尾的一个格式分支上有独有资产。

**必须直说的判断**：若按顺序补齐植被指数、波段识别、直方图、等面积分级、Shapefile、ISOXML、速率模型，产出物就是 NDVItoTaskmap 的等价物——而那个项目 7 个月 3 star。因此补齐的意义取决于目标：

- **目标是自用 / 交付客户**：速率模型（2.1 首条）+ Shapefile + ISOXML 是**必须**的，否则下游农机读不了，前面所有统计都白做。
- **目标是开源被采用**：不要正面追平，走**矩形栅格处方**这条独有路线，定位为"栅格处方生成器"，与 NDVItoTaskmap 这类"矢量 / ISOXML 作业图工具"互补（矢量定义作业区、栅格承载逐像元速率），并在 README 中明确写出这一定位。

**补齐优先级**：

| 阶段 | 内容 | 理由 |
| --- | --- | --- |
| 1 | 速率模型 → Shapefile → ISOXML | 不做则无人能真正使用产物 |
| 2 | 植被指数 + 自动波段识别 + 直方图 + 等面积分级 | 不做则"NDVI 处方"名不副实 |
| 3 | License + 修复构建 + 免构建产物 + 用户文档/demo | 采用门槛，成本最低、收益最直接 |
| 4 | 把栅格处方做深（多波段处方、按面积速率写入、与 ISOXML 双出口） | 唯一护城河 |

具体排期见 `docs/superpowers/plans/2026-11-14-unified-roadmap.md`。
