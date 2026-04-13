# GeoTIFF Debug Demo Design

**目标**

提供一个独立于主项目的单文件 `HTML` 调试页，用最短链路验证本地 `tif/tiff` 文件是否能在浏览器中完成读取、元信息解析和降采样预览渲染。

**范围**

- 支持本地上传 `tif/tiff`
- 展示文件名、文件大小、宽高、CRS、bbox、像元大小、波段数
- 展示阶段状态和时间戳日志
- 使用 `Canvas` 渲染降采样预览
- 失败时展示明确报错和失败阶段

**非目标**

- 不接入 `OpenLayers`
- 不实现围栏、网格、导出
- 不处理完整图层管理

**核心设计**

页面只依赖浏览器原生 `FileReader`、`Canvas` 和本地 `geotiff` 浏览器包。读取链路固定为：

1. 选择文件
2. `FileReader` 读取 `ArrayBuffer`
3. `GeoTIFF.fromArrayBuffer()`
4. `getImage()` 读取元信息
5. `readRasters()` 读取缩略像元
6. 归一化后写入 `Canvas`

这样能把“文件读取”和“页面预览”从主项目地图渲染链中彻底剥离，单独判断问题究竟出在 TIFF、本地浏览器、还是地图层。
