# 工程状态往返（Round-trip）设计

> 状态：设计稿，未实施。本文只定义契约与实现路径，不含代码改动。
> 日期：2026-11-14

## 1. 背景

### 1.1 用户问题

用户反馈的原话是：「我设置好导出以后无法再导入还是原来的效果」。

具体表现：配置好围栏、网格参数、分类方案（含颜色/标签/施肥量）后导出 GeoTIFF 或 GeoJSON，
再想导回来继续编辑或核对时，**一切回到初始状态**——分类配色、网格、围栏全部消失。

### 1.2 代码根因（已逐条核实）

问题不是「没做导入」这么简单，而是四条原因叠加：

| # | 根因 | 证据 |
| --- | --- | --- |
| R1 | 唯一的导入通道只接受 TIFF，GeoJSON 没有入口 | `accept=".tif,.tiff,image/tiff"` in `src/app/layout/LeftPanel.tsx:151` |
| R2 | **文件选择会主动清空所有设置** | `resetFence(); resetGrid(); resetMapUi();` in `src/app/layout/LeftPanel.tsx:158-160`（选文件）与 `172-175`（移除） |
| R3 | 零持久化，设置只活在内存 | 全仓无 `localStorage` / `sessionStorage` / `indexedDB` / `JSON.parse`；`src/shared/geo/rasterIo.ts:253` 的 `FileReader` 只用于读影像字节 |
| R4 | 导出文件是「有损照片」，且不含任何设置元数据 | 像素被覆写为网格聚合值、围栏外写 nodata（`src/shared/geo/gridAggregation.ts:664-694`）；writer 的写参只有 geo 相关透传字段，没有自由元数据落点（`src/shared/geo/geotiffWriter.ts:13-26`） |

其中 **R2 是「导入后效果不对」的直接机械原因**：即使导入的是自己刚导出的文件，设置也是被主动删掉的。
另外 `rotationDeg` 目前**连 GeoJSON 都没导出**（`src/features/export/exportGeoJson.ts:37-82` 只写 `cellSize`）。

### 1.3 为什么「重新导入导出的 GeoTIFF」现在必然不像

导出物与工作现场之间有四处不可逆损失：

1. 像素值已被替换为网格聚合值（`outputValue`），不再等于原始影像；
2. 围栏外形没有被记录（只在 filesystem 里留下一个「非 nodata 轮廓」）；
3. `cellSize` / `rotation` / `aggregationMode` / 分类规则 / `applicationRate` 全部只存在内存；
4. 导入路径（R2）会主动清空第 3 项，即使它还在内存里也保不住。

## 2. 目标与非目标

### 2.1 目标

- **G1** 用户能把当前完整设置保存为一个工程文件，并完整打开还原。
- **G2** 导出的 GeoTIFF 自带设置信息，**重新导入该文件即可还原现场**（含分类配色与网格）。
- **G3** 导出的 GeoJSON 同样自带设置信息，并可单独导入围栏。
- **G4** 页面刷新、误点「移除」不再丢失设置（自动草稿）。
- **G5** 还原必须**可验证**：同一套输入重复导出，像素级结果一致（幂等）。

### 2.2 非目标

- 不做后端、不做账号、不做云端同步。
- 不试图从像素反推设置（见 §3 核心判断）。
- 不做多围栏队列、不做批量导出（属 README 既有 TODO，与本设计正交）。
- 本次不引入新的运行时依赖（校验器手写；base64 用浏览器原生 `atob/btoa` + `TextEncoder/TextDecoder`）。

## 3. 核心判断：存「配方」，不要指望从「照片」还原

导出的 GeoTIFF 是销毁性的（值是均值、围栏外形未存），因此正确方向不是逆向推导，而是：

> 把完整设置序列化成一份 **recipe（配方）**，单独存为工程文件、或内嵌进导出文件；
> 导入时按配方还原现场，而不是从像素里猜设置。

这条判断决定了后面所有设计：**配方是唯一事实来源**，像素只是产物。

### 3.1 方案比较

| 方案 | 做法 | 评价 |
| --- | --- | --- |
| A. 从导出像素反推设置 | 检测 nodata 轮廓当围栏、按值突变推网格 | ❌ 不可靠；围栏顶点、分类规则、rotation 根本无法恢复 |
| B. 只做工程文件（sidecar） | 另存 `.ttot.json`，导入时配对 | ✅ 简单可靠，但用户必须同时保管两个文件 |
| C. 只做内嵌（导出文件自带） | 把配方写进 TIFF tag / GeoJSON foreign member | ✅ 单文件即可往返，但纯 GeoJSON 围栏导入需要额外分支 |
| **D. B + C 同一份配方，双通道** | 同一 `ProjectSnapshot` 既存工程文件也内嵌 | ✅ **采用**。两个出口共用一套序列化与校验，实现成本几乎不增加 |

**结论：采用 D。** 配方结构只有一份，落盘位置有两个。

## 4. 数据契约

新增 `src/features/project/projectSnapshot.ts`。

### 4.1 类型定义

```ts
export const PROJECT_SNAPSHOT_KIND = 'ttot-project';
export const PROJECT_SNAPSHOT_VERSION = 1;

/** 源影像轻量指纹（按用户选择：不做内容哈希） */
export type SourceFileFingerprint = {
  fileName: string;
  size: number;
  lastModified: number;
};

export type ProjectSnapshotSource = {
  fingerprint: SourceFileFingerprint;
  sourceLabel: string;
  /** 用于还原时校验 CRS 是否一致，不一致会导致网格位置整体偏移 */
  crsCode: string;
  width: number;
  height: number;
  boundingBox: [number, number, number, number];
  resolution: [number, number, number?];
};

export type ProjectSnapshotFence = {
  /** 归一化后的环数组（外环 + 洞环），已闭合 */
  rings: FenceRings;
};

export type ProjectSnapshotGrid = {
  cellSize: number;
  /** 规范化到 [0, 360)，与 LeftPanel 的写入语义一致 */
  rotation: number;
  aggregationMode: GridAggregationMode;
};

export type ProjectSnapshotClassification = {
  /** 复用现有类型，含 visible 字段 */
  layers: Array<RasterClassificationLayer & { visible: boolean }>;
  activeLayerId: string | null;
  visibleLayerId: string | null;
};

export type ProjectSnapshotView = {
  layers: { raster: boolean; fence: boolean; grid: boolean };
  gridRenderSettings: GridRenderSettings;
};

export type ProjectSnapshotV1 = {
  kind: typeof PROJECT_SNAPSHOT_KIND;
  version: 1;
  savedAt: string; // ISO 8601
  appVersion?: string;

  source: ProjectSnapshotSource | null;
  fence: ProjectSnapshotFence | null;
  grid: ProjectSnapshotGrid;
  classification: ProjectSnapshotClassification;
  view: ProjectSnapshotView;

  /**
   * 导出侧写入、还原侧只读的元信息。
   * 用于幂等性判定与 nodata 哨兵还原（见 §8）。
   */
  derived: {
    exportNoDataValue: number | null;
    /** 导出产物是否被聚合改写；用于提示"这是结果文件而非原始影像" */
    aggregated: boolean;
    /** 处方波段在导出文件中的索引，无则为 null */
    prescriptionBandIndex: number | null;
  };
};
```

### 4.2 只存输入，不存派生（关键决策）

以下状态**一律不进快照**，导入后重新计算：

| 不存的字段 | 所在位置 | 理由 |
| --- | --- | --- |
| `fence.summary` | `src/shared/types/fence.ts:5-9` | 由 `buildFenceFeature(rings)` 重算，存了会陈旧 |
| `grid.cells` | `src/features/grid/gridStore.ts:19` | 由围栏 + 参数派生 |
| `grid.summary` | 同上 | 同上 |
| `grid.origin` | 同上 | 同上 |
| `metadata.metricTransform` | `src/shared/types/raster.ts:128` | 由 `crsCode + boundingBox` 派生 |
| `preview` / `validityMask` | `src/features/map/rasterStore.ts:17-21` | 从影像文件重算，体积大 |
| `hoverInfo` | `src/features/map/mapUiStore.ts:35` | 瞬态 |
| `loadingStore` 全部 | `src/features/loading/loadingStore.ts` | 瞬态 |
| `rasterRenderSettings` | `src/features/map/mapUiStore.ts:36` | **当前生产代码无任何消费方**（仅 `tests/features/map-ui-store.test.ts:121` 断言）→ 纳入快照没有意义，暂不收录 |

**理由**：派生数据入快照会带来「配方与算出来的结果不一致」这一类最难排查的问题；且 cells 可达 5 万个，体积不可接受。

### 4.3 校验器（手写，不引依赖）

```ts
export type SnapshotParseResult =
  | { ok: true; snapshot: ProjectSnapshotV1; warnings: string[] }
  | { ok: false; errors: string[] };

export function parseProjectSnapshot(text: string): SnapshotParseResult;
export function validateProjectSnapshot(raw: unknown): SnapshotParseResult;
export function serializeProjectSnapshot(s: ProjectSnapshotV1): string; // JSON.stringify(s, null, 2)
export function migrateProjectSnapshot(raw: unknown): unknown;          // vN -> v(N+1) 逐级
```

校验规则（必须逐条实现，陌生人文件不能让应用崩）：

- `kind === 'ttot-project'`，`version` 为有限正整数；
- `version > PROJECT_SNAPSHOT_VERSION` → 拒绝并提示「请升级工具版本」（不要尝试解析未来格式）；
- `fence.rings`：`FencePosition[][]`，每点为两个有限数；**坐标点总数上限 200,000**、环数上限 1,000（防 DoS）；外环闭合数 < 4 视为无效并降级为 `fence: null` + warning；
- `grid.cellSize`：有限且 > 0；`rotation`：有限，写入时规范化到 `[0, 360)`；
- `aggregationMode ∈ {'mean','max','min'}`，非法则回退 `'mean'` 并 warning；
- `classification.layers` 长度上限 200；每条 `rules` 长度上限 500；`gradientStops` 长度上限 500；
- 颜色必须匹配 `/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i`，非法则替换为 `#cccccc` 并 warning；
- `applicationRate`：`null` 或有限数（含负数不报错，交由 UI 提示）；
- **未知字段一律忽略**（向前兼容）；
- 任何字段缺失时**不使用 `undefined` 传播**，一律落到显式默认值。

## 5. 纯函数层与应用层分离

为了可测，序列化与「变成 store 补丁」必须是纯函数，只有最后一层碰 store。

```ts
/** 纯函数：从当前 store 快照产出配方 */
export function exportProjectSnapshot(input: {
  raster: Pick<RasterState, 'sourceFile' | 'sourceLabel' | 'metadata'>;
  fence: Pick<FenceState, 'fence'>;
  grid: Pick<GridState, 'cellSize' | 'rotation' | 'aggregationMode'>;
  mapUi: Pick<MapUiState, 'classificationLayers' | 'activeClassificationLayerId'
                      | 'visibleClassificationLayerId' | 'layers' | 'gridRenderSettings'>;
  derived?: Partial<ProjectSnapshotV1['derived']>;
}): ProjectSnapshotV1;

/** 纯函数：配方 -> store 补丁（可单独测试 round-trip） */
export function toStorePatches(s: ProjectSnapshotV1): {
  fenceRings: FenceRings | null;
  grid: ProjectSnapshotGrid;
  classification: ProjectSnapshotClassification;
  view: ProjectSnapshotView;
};

/** 唯一有副作用的一层：把补丁写进各 store */
export function applyStorePatches(patches: ReturnType<typeof toStorePatches>): void;
```

`applyStorePatches` 的调用顺序要求：**先分类/视图，后围栏，最后网格参数**。
原因：`useMap.ts:908` 的网格预览 effect 依赖 `fence`、`debouncedCellSize`、`debouncedRotation`、`aggregationMode`，
若中途先后触发会产生多次无谓的重算；一次性写完再让 effect 跑一轮更省。

### 5.1 需要新增的 store action

| store | 现有能力 | 缺口 | 建议新增 |
| --- | --- | --- | --- |
| `fenceStore` | `setFence(rings)` | 够用（会置 `mode='idle'`、清 validationMessage） | 无 |
| `gridStore` | `setCellSize/setRotation/setAggregationMode` | 三次 set 会触发多次重算 | `restoreGrid(params)` 原子写入 |
| `mapUiStore` | 只有 `addClassificationLayer` / `updateClassificationLayer` / 单个 `toggleLayer` | 无法原子地整体替换分类方案集合 | `restoreUiState({ layers, classificationLayers, activeId, visibleId, gridRenderSettings })` |

**注意**：`mapUiStore.reset()`（`src/features/map/mapUiStore.ts:524`）会把分类方案重置为默认 NDVI 层。
导入配方时**绝不能调用 `reset`**，必须用 `restoreUiState` 整体替换。

## 6. 源文件指纹

按已确认的取舍：**`fileName + size + lastModified`，不做内容哈希**。

```ts
export type FingerprintMatch = 'match' | 'mtime-differs' | 'mismatch';

export function compareFingerprint(
  saved: SourceFileFingerprint,
  current: SourceFileFingerprint,
): FingerprintMatch;
```

判定规则：

1. `fileName` 与 `size` 均相等 →
   - `|lastModified 差| <= 2000ms` → `match`；
   - 否则 → `mtime-differs`（部分平台复制/解压会改 mtime，**不阻断**，仅 UI 提示）；
2. `size` 相等但 `fileName` 不同 → `mismatch`，提示「文件大小一致，可能是重命名；是否继续？」并给出继续按钮；
3. 其余 → `mismatch`，提示重新选择原影像，但**允许用户强制继续**（用户可能有正当理由）。

补充一致性校验（比指纹更重要，必须做）：

- **CRS 一致性**：还原时把配方里的 `crsCode` 与本次加载影像的 `crsCode` 比对；不一致时**必须显式警告**——因为 `metricTransform`（`src/shared/geo/metricTransform.ts:33`）随 CRS 改变，网格原点会整体偏移，产出静默错数据。
- **范围包含性**：围栏 bbox 必须落在新影像 bbox 内，否则提示「围栏超出影像范围」并禁止生成网格（复用 `isBboxInside`，`src/features/map/mapUtils.ts:40`）。

## 7. 自动草稿（localStorage）

| 项 | 决策 |
| --- | --- |
| key | `ttot:draft:v1` |
| 写入时机 | 订阅 `fenceStore` / `gridStore` / `mapUiStore`，debounce 1000ms 后写入 |
| 内容 | 与 `ProjectSnapshotV1` 完全同构（`source` 只有指纹，`File` 对象不可序列化） |
| 体积保护 | 序列化结果 > 1MB 则跳过写入并 debugLog；避免 `QuotaExceededError` |
| 异常处理 | `try/catch` 包住 `setItem`（Safari 隐私模式会抛），失败即静默降级为不持久化 |
| 多标签页 | 记录 `tabId`（`crypto.randomUUID()`）；写入前比对，`tabId` 不同则不覆盖。**接受「同标签页内后写覆盖前写」的简单语义**，在文档与 UI 中明确 |
| 启动行为 | **不静默自动恢复**。仅检测到草稿时展示「检测到上次会话（保存于 X），是否恢复？」，用户确认后进入还原流程 |
| 不静默恢复的原因 | 页面刷新后 `File` 对象必然丢失，静默恢复会得到「有围栏无影像」的诡异状态，比不恢复更糟 |

## 8. 内嵌进 GeoTIFF

### 8.1 tag 选择（已核实）

| 候选 | tag | geotiff.js 可读性 | 结论 |
| --- | --- | --- | --- |
| `ImageDescription` | 270 / `0x010E` | ✅ 在 `globals.js:18` 的 `fieldTagNames` 中，`fileDirectory.ImageDescription` 直接可读 | **主用** |
| `GDAL_METADATA` | 42112 / `0xA480` | ✅ 在 `globals.js:106`，但需包装 XML `<Item>`，且有 `getGDALMetadata()` 的 Item 过滤逻辑 | 预留（未来与 GDAL 生态互认时双写） |
| 任意私有 tag | e.g. 65000 | ❌ **不可用**。`geotiff.js:418` 是 `fileDirectory[fieldTagNames[fieldTag]] = value`，未知 tag 的 key 为 `undefined`，多个未知 tag 会互相覆盖 | 禁用 |

writer 已具备 ASCII tag 写入能力（`createAsciiTag`，用于 34737 / 42113，见 `src/shared/geo/geotiffWriter.ts:299`、`:303`），
因此新增 270 只是加一个分支，不涉及新的编码器逻辑。

### 8.2 编码格式

```
TTOT1:<base64(UTF-8(JSON.stringify(snapshot)))>
```

- 前缀 `TTOT1:` 用于**快速探测**，避免误读其他软件写入的 ImageDescription（例如 GDAL 会写 `"GDAL 3.x"`）；
- base64 避免非 ASCII 与控制字符破坏 ASCII tag 语义；
- 版本号同时存在于前缀与 `snapshot.version`，前缀用于**低成本拒绝**未来格式；
- 体积预算：预期 2–8KB（围栏数十顶点 + 数条规则）。**上限 32KB**，超限则不内嵌，UI 提示「设置过大，已跳过内嵌，请另存工程文件」；
- 暂不压缩。若后续超预算，再引入原生 `CompressionStream('deflate-raw')`（无需新依赖）。

### 8.3 写入侧改动

```ts
type GeoTiffWriteOptions = {
  // ...现有字段
  imageDescription?: string; // 新增：tag 270
};
```

- 当 `imageDescription` 非空时 `tags.push(createAsciiTag(270, imageDescription))`；
- writer 已有 tag 排序与 IFD 写出逻辑（`src/shared/geo/geotiffWriter.ts:306`、`:335-356`），无需改动；
- 导出调用点 `src/features/export/exportGeoTiff.ts:145-172` 传入内嵌字符串。

**已知行为变更需登记**：导出会**覆盖源文件的 ImageDescription**。当前实现本就没有透传它（writer 不写 270），所以实际是新增而非覆盖用户数据；但仍应在 README/CHANGELOG 注明。

### 8.4 探测优先级（导入任意 `.tif` 时）

1. `fileDirectory.ImageDescription` 以 `TTOT1:` 开头 → 解析标签 → 校验配方；
2. `fileDirectory.GDAL_METADATA` 含 ttot Item → 解析（预留分支，暂不实现）；
3. 都没有 → **走现有影像流程，行为完全不变**（回归底线）。

## 9. 处方波段与分类门限（必须一并解决）

### 9.1 问题

rules 模式导出的文件是 2 波段（主波段 + Float32 处方波段，`src/features/export/exportGeoTiff.ts:134-137`）。
而复色与分类预览被硬编码为单波段门限：

```ts
// src/features/map/useMap.ts:464-469 以及 :524-530
if (preview.sampleBandCount === 1 && previewSampleData && visibleClassificationLayer && workerRef.current)
```

→ **导入自己导出的处方图时，分类着色根本不会应用**。这会让「还原效果」在 rules 模式下失效，是本设计必须先解决的连带问题。

### 9.2 方案

在 `RasterPreview`（`src/shared/types/raster.ts:82-90`）增加：

```ts
/** 参与"分类与预览 RGB"映射的波段索引集合；默认 [0] */
displayBandIndexes: number[];
/** 处方/附加波段索引；用于在 UI 上说明，不参与分类 */
prescriptionBandIndexes: number[];
```

判定来源（按优先级）：

1. **通用判定（优先）**：读取 `fileDirectory.ExtraSamples`（writer 对 `samplesPerPixel > 1 && photometric === 1` 已写 tag 338，值为 0=Unspecified，见 `src/shared/geo/geotiffWriter.ts:285-288`）。存在 ExtraSamples 时，把额外波段排除出显示波段集合。
2. **配方判定**：若存在内嵌配方且 `derived.prescriptionBandIndex !== null`，直接采用。

对应地需要放宽 `bandCount = min(3, spp)` 与 `extractInterleavedBand` 的入参
（`src/shared/geo/rasterPreview.ts`），把「参与显示的波段集合」显式传入，而不是隐含由 `spp` 推导。

## 10. 内嵌进 GeoJSON

- `fence.geojson` 与 `grid.geojson` 顶层增加 foreign member：

```json
{ "type": "FeatureCollection", "ttot:project": { "...": "ProjectSnapshotV1" }, "features": [ ... ] }
```

GeoJSON 规范允许 foreign members，不影响其他软件读取。

- 因此**单独导入 `grid.geojson` 也能还原全部设置**（配方里有围栏和网格参数）。
- 新增独立的 GeoJSON 输入通道（与 TIFF 输入分离，避免误判同一次选择）。导入时的分支：
  1. 顶层有 `ttot:project` → 走完整还原流程；
  2. 无但首要素是 `Polygon` → 提示两个选项：「只恢复围栏」/「取消」；
  3. 其他 → 明确报错「不支持的文件类型」。
- `rotationDeg` 必须同时写入快照与 GeoJSON（修正 `src/features/export/exportGeoJson.ts` 现状）。

## 11. 还原流程状态机

```
用户导入文件
│
├─ .tif / .tiff
│  ├─ 有内嵌配方
│  │  ├─ 校验失败 ──────────────→ 结构化报错，不改动当前状态
│  │  └─ 校验通过
│  │     ├─ 配方源指纹 == 本文件指纹
│  │     │   → 直接还原（围栏/网格/分类），提示「已根据内嵌设置还原」
│  │     └─ 不匹配（这是导出结果，原影像为 X）
│  │        → 提示并给两个选项：[仍在此文件上还原] / [选择原影像]
│  │           └─ 选择原影像 → 校验指纹与 CRS → 通过则还原；CRS 不一致强警告
│  └─ 无内嵌配方 ───────────────→ 现有流程（清空派生状态，行为不变）
│
├─ .geojson
│  ├─ 有 ttot:project ──────────→ 完整还原流程（需源影像时引导选择）
│  └─ 只有 Polygon ─────────────→ 提示「只恢复围栏」/ 取消
│
└─ .ttot.json（工程文件）
   └─ 与「有内嵌配方」分支完全同路径（同一份配方结构）
```

**事务性要求**：解析 → 校验 → CRS 校验全部通过后，才允许触碰 store；任何一步失败都不产生「半还原」状态。
实现上由 `applyStorePatches` 只在最后一步被调用保证。

### 11.1 源影像缺失时的降级能力

| 能力 | 无源影像时 |
| --- | --- |
| 还原围栏几何与摘要 | ✅ |
| 还原网格参数（cellSize/rotation/aggregationMode） | ✅ |
| 还原分类方案（颜色/标签/applicationRate） | ✅ |
| 渲染网格聚合值 | ❌ 需影像；提示「请重新选择源影像以计算聚合」 |
| 导出 | ❌ 同上 |

## 12. 幂等性论证

**命题**：设导出栅格 `R` 由原始栅格 `D`、围栏 `F`、网格参数 `G` 生成，`R` 的每个像元 = 其所属 cell 的 `outputValue`（未命中/围栏外为 nodata）。
则用同一组 `(F, G)` 在 `R` 上重跑聚合，得到的 `cellsById[*].outputValue` 与第一次**完全相同**。

**论证**：

1. **窗口一致**：两次的像素窗口都由 `F` 的 bbox 反算并 clamp（`getPixelWindowFromFenceBoundingBox`，`src/shared/geo/geotiffExport.ts:172-203`），而 `R` 的范围恰好等于第一次的窗口 → 覆盖面一致。
2. **值一致**：同一 cell 内所有非 nodata 像元在 `R` 中值相等（= 第一次的 `outputValue`）→ 均值/最大/最小仍是该值（`finalizeAggregation`，`src/shared/geo/gridAggregation.ts:363-390`）。
3. **空 cell 一致**：第一次 `validPixelCount === 0` 的 cell 在 `R` 中全为 nodata → 第二次仍无有效像元 → 仍输出空（`gridAggregation.ts:368-373`）。

**必须覆盖的边界与反例**：

| # | 情况 | 影响 | 对策 |
| --- | --- | --- | --- |
| E1 | **nodata 哨兵碰撞**：`exportNoDataValue = 0` 且某 cell 均值恰为 `0` | 该 cell 在 `R` 中与 nodata 不可区分 → 第二次聚合丢失该 cell | 配方 `derived.exportNoDataValue` 记录哨兵；还原时优先采用配方记录的 nodata；并检查 `pickExportNoDataValue`（`src/shared/geo/geotiffExport.ts:574`）的候选回退是否覆盖 `0` 碰撞场景 |
| E2 | 窗口被 clamp 到原始影像边界 | 第一次与第二次窗口相同 → 无影响 | —— |
| E3 | 用户在还原后又改了 `cellSize`/`rotation` | 幂等性不适用 | 属正常业务，不做特殊处理 |
| E4 | `rotation ≠ 0` | cell 归属由度量空间旋转判定，与窗口无关 → 一致 | 但 `rotationDeg` 必须进配方（P3 修复项） |
| E5 | 多波段 | `R` 的所有波段都被写成主波段聚合值（`gridAggregation.ts:664`）→ 第二次一致 | 与幂等性正交；但**原始多波段信息已丢失**，属 P0 必修问题 |

E1 是幂等性的**唯一真实漏洞**，且它同时是数据正确性问题，因此必须与 P0 的整数栅格修复一起处理。

## 13. 错误处理与提示文案

| 场景 | 提示 |
| --- | --- |
| 配方版本高于当前工具 | 「该工程由更新版本创建（v{n}），请升级后再打开。」 |
| 配方校验失败 | 「工程文件已损坏或不完整：{前 3 条错误}」 |
| 源影像缺失 | 「已还原围栏与分类方案。请选择源影像以计算网格聚合。」 |
| 指纹不匹配 | 「当前影像与工程记录的源文件不一致（记录：{name}）。继续可能得到错误结果。」 |
| CRS 不一致 | 「影像坐标系不一致（记录 {a}，当前 {b}），网格位置会整体偏移，已停止自动还原。」 |
| 围栏超出新影像范围 | 「围栏超出影像范围，请重新绘制或选择正确的影像。」 |
| 内嵌配方过大 | 「设置过大（{n}KB），已跳过内嵌，请另存工程文件。」 |
| GeoJSON 无可识别信息 | 「该 GeoJSON 不含工程信息。是否只恢复围栏？」 |

所有错误**不得抛出到顶层**，一律转为上述文案；解析函数返回结构化错误列表。

## 14. 测试策略

### 14.1 单元测试（新增 `tests/project/project-snapshot.test.ts`）

- 校验器全分支：缺 `kind`、`version` 非法、未来版本、坐标非有限数、点数超限、颜色非法、`aggregationMode` 非法、未知字段被忽略；
- 边界降级：外环 < 4 点、`rules` 超长 → warning 而非 error；
- 指纹比较：`match` / `mtime-differs`（±1500ms）/ `mismatch`（size 同 name 异）；
- 编解码往返：`TTOT1:` + base64 → 中文标签/颜色不损坏；
- 探测负例：`ImageDescription = "GDAL 3.9.0"` 不得被误认为配方。

### 14.2 纯函数往返（核心断言）

```
toStorePatches(exportProjectSnapshot(seed)) 深等于 seed 的对应切片
```

`seed` 需覆盖：gradient 与 rules 两种模式、多套分类方案、含洞环的围栏、`rotation = 47`、`applicationRate` 为 `null` 与小数。

### 14.3 集成测试（组件层）

- 导入带内嵌配方的 TIFF → 断言围栏恢复、`cellSize/rotation` 恢复、分类方案恢复，**且分类着色生效**（覆盖 §9 的 `sampleBandCount` 门限）；
- 导入普通第三方 TIFF → 断言行为与现状一致（回归）；
- 断言「导入配方后围栏仍在」，即钉死 R2 的修复（`src/app/layout/LeftPanel.tsx:158-160` 不再无条件 reset）；
- 草稿：模拟 store 变化 → 断言 localStorage 被写入；模拟 `setItem` 抛异常 → 断言不崩。

### 14.4 幂等测试（用真实 writer + reader）

- 导出 → 用 geotiff.js 读回 → 再导出 → **两次像素数组逐一比较**；
- 必须包含 E1 用例：构造某 cell 均值为 `0` 且 `nodata = 0` 的数据，断言还原后该 cell 是否保留（先暴露问题，再修 `pickExportNoDataValue`）。

### 14.5 不测的部分（明确写出）

- 不在 jsdom 里测真实文件下载（沿用现有 `mock` 风格，见 `tests/export/exportGeoTiff.test.ts`）；
- 不做端到端浏览器测试（项目无 Playwright 基础设施，本次不引入）。

## 15. 分阶段实施计划

### P0｜地基修复（前置，0.5–1 天）

| # | 任务 | 改动点 |
| --- | --- | --- |
| 0-1 | 修 `metricTransform` 类型错误，恢复 `pnpm build` | `src/features/map/useMap.ts:691,694`、`src/shared/types/grid.ts:39-44` |
| 0-2 | 加 `LICENSE`(MIT) 与 CI（`test` + `build`） | 新增 `LICENSE`、`.github/workflows/ci.yml` |
| 0-3 | 修整数栅格导出数值损坏 + 多波段被主波段覆盖 | `src/features/export/exportGeoTiff.ts:102`、`src/shared/geo/gridAggregation.ts:664` |
| 0-4 | 修 nodata 哨兵碰撞（E1） | `src/shared/geo/geotiffExport.ts:574` |

**验收**：`pnpm build` 与 `pnpm test` 双绿；Uint16 影像导出的均值不再被截断；新增幂等测试通过。

> 0-3 / 0-4 不修，则「还原」回来的数字本身是错的，后续工作失去意义，故列为前置。

### P1｜配方化与工程文件（核心，2–3 天）

| # | 任务 | 新增/改动 |
| --- | --- | --- |
| 1-1 | `ProjectSnapshotV1` + 校验器 + 序列化/迁移 | 新增 `src/features/project/projectSnapshot.ts` |
| 1-2 | `exportProjectSnapshot` / `toStorePatches` / `applyStorePatches` | 同上 |
| 1-3 | `gridStore.restoreGrid`、`mapUiStore.restoreUiState` | `src/features/grid/gridStore.ts`、`src/features/map/mapUiStore.ts` |
| 1-4 | 顶栏「保存工程 / 打开工程」(`.ttot.json`) | `src/app/layout/TopBar.tsx` |
| 1-5 | 移除 `LeftPanel` 的无条件 `reset*`，改为调用方决定 | `src/app/layout/LeftPanel.tsx:158-160, 172-175` |
| 1-6 | 指纹比较 + CRS/范围一致性校验与提示 | 新增于 `projectSnapshot.ts` |
| 1-7 | localStorage 草稿 + 启动恢复提示 | 新增 `src/features/project/draftStorage.ts` |

**验收**：A（纯函数往返）、D（刷新恢复）、E（第三方 TIFF 回归）三项通过；换文件不再清空设置。

### P2｜导出文件自带配方（1–2 天）

| # | 任务 | 改动点 |
| --- | --- | --- |
| 2-1 | writer 支持 `imageDescription`（tag 270） | `src/shared/geo/geotiffWriter.ts:13-26, 269-304` |
| 2-2 | 导出时内嵌配方（含体积上限与超限提示） | `src/features/export/exportGeoTiff.ts:145-172` |
| 2-3 | 导入时探测并还原（`TTOT1:` 前缀） | `src/features/map/useRasterLoader.ts` / 新增 `projectImport.ts` |
| 2-4 | 解决处方波段导致的分类门限失效 | `src/shared/types/raster.ts:82-90`、`src/shared/geo/rasterPreview.ts`、`src/features/map/useMap.ts:464-469, 524-530` |
| 2-5 | GeoJSON 内嵌 `ttot:project` + 独立 GeoJSON 输入通道 | `src/features/export/exportGeoJson.ts`、`src/app/layout/LeftPanel.tsx` |

**验收**：B（文件往返：围栏顶点/`cellSize`/`rotation`/分类规则/每 cell `outputValue` 全一致）、C（幂等像素级相同）通过。

### P3｜一致性收口（0.5–1 天）

| # | 任务 |
| --- | --- |
| 3-1 | `rotationDeg` 落 GeoJSON 与快照 |
| 3-2 | 幂等回归测试纳入 CI |
| 3-3 | README 补充「工程文件 / 往返还原」章节与行为变更登记（ImageDescription 占用） |
| 3-4 | 清理死代码与重复实现（`grid.ts` 的 `buildCellPolygon`/`resolveMetricTransform`、`LeftPanel` 与 `classificationUtils` 的重复格式化函数、`tests/tmp-displayvalue.test.tsx`） |

## 16. 接口影响面

| 文件 | 改动性质 |
| --- | --- |
| `src/features/project/projectSnapshot.ts` | 新增（契约 + 校验 + 转换） |
| `src/features/project/draftStorage.ts` | 新增（localStorage） |
| `src/features/project/projectImport.ts` | 新增（探测 + 还原编排，P2） |
| `src/shared/geo/geotiffWriter.ts` | 加 `imageDescription`（向后兼容，可选参数） |
| `src/shared/geo/geotiffExport.ts` | nodata 碰撞修复；导出侧组装配方 |
| `src/shared/types/raster.ts` | `RasterPreview` 增加 `displayBandIndexes` / `prescriptionBandIndexes` |
| `src/shared/geo/rasterPreview.ts` | 显示波段集合显式化 |
| `src/features/grid/gridStore.ts` | 加 `restoreGrid` |
| `src/features/map/mapUiStore.ts` | 加 `restoreUiState`（不破坏现有 API） |
| `src/features/export/exportGeoJson.ts` | 加 foreign member + `rotationDeg` |
| `src/features/map/useMap.ts` | 修类型错误；放宽单波段门限 |
| `src/app/layout/TopBar.tsx` | 加保存/打开工程 |
| `src/app/layout/LeftPanel.tsx` | 取消无条件 reset；加 GeoJSON 通道 |

除 `useMap.ts` 的类型修复外，其余均为**增量**改动，不改变现有导出格式的既有字段语义。

## 17. 风险与未决问题

| # | 风险/未决 | 说明与倾向 |
| --- | --- | --- |
| U1 | `ImageDescription` 是通用字段 | 我们占用它写配方。用 `TTOT1:` 前缀保证不误读他人文本；但已在别处消费该字段的下游工具会看到一段 base64。倾向接受，并在 README 登记 |
| U2 | 是否改用 `GDAL_METADATA`(42112) | 更「规范」，但需 XML 包装与 Item 过滤。倾向：先 `ImageDescription`，若收到 GDAL 生态互认需求再双写；配方结构不变，切换成本低 |
| U3 | 多标签页草稿互相覆盖 | 用 `tabId` 抑制跨标签覆盖；同标签内后写覆盖前写，接受 |
| U4 | 无源影像时不能重算聚合 | 已在 §11.1 明确降级边界，UI 需清晰表达「缺影像」而非静默空白 |
| U5 | `rotation` 规范化语义（`[0,360)` 与 `[-180,180]`） | 现状 `LeftPanel.tsx:133` 写入 `[0,360)`，但 `gridSummary.rotation` 可能来自输入侧。快照统一按 `[0,360)` 存储，UI 展示沿用现状 |
| U6 | 是否把派生结果也存进快照以支持「无源影像查看」 | **倾向不做**：派生数据入快照会造成配方与结果不一致，且 cells 可达 5 万（`maxPreviewCells: 50_000`，`src/features/map/useMap.ts:753`），体积不可接受 |
| U7 | 幂等性依赖 nodata 判定正确 | 必须先完成 P0-4；否则 §12 的 E1 会让还原静默丢格 |

## 18. 结论

- 用户问题的根因是 **R1–R4 四条叠加**，其中 R2（选文件即清空设置）是「导入后效果不对」的直接原因，修复成本极低。
- 正确方向是**存配方**（单一 `ProjectSnapshotV1` 契约），通过**工程文件 + 文件内嵌**双通道落盘；不从像素反推设置。
- 数值层面往返是**可成立**的（§12 幂等性论证），唯一真实漏洞是 nodata 哨兵碰撞（E1），须与 P0 的整数栅格修复一并处理。
- 一个必须连带解决的具体障碍：处方波段使 `sampleBandCount === 1` 门限失效（§9），否则 rules 模式的「还原」在视觉上依然不成立。
- 建议实施顺序：**P0 → P1 → P2 → P3**。P0 是地基，P1 投入产出比最高（刷新/换文件不再丢设置），P2 直接兑现用户「重新导入导出的文件即还原」的原始诉求。
