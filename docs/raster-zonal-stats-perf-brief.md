# In-browser large-raster processing & zonal statistics — state of the art (research brief)

Scope: browser-only React 19 + Vite + OpenLayers 10 + geotiff.js app; user loads a local 100s-of-MB
GeoTIFF, draws a fence, builds a grid, computes per-cell mean of one band over valid pixels, classifies,
exports GeoJSON + clipped prescription GeoTIFF. Target scale: **10k × 10k float32 single band = 100 M
pixels ≈ 400 MB raw**, aggregated over a few thousand grid cells.

**Verdict up front:** the dominant cost is almost always *decode + reading pixels you do not need*, not the
aggregation arithmetic. The single highest-leverage algorithmic change is to stop doing
point-in-polygon per cell and instead do **one linear pass over the needed raster window accumulating into
per-cell-id accumulators** (the exact same idea as `exactextract`'s "raster-sequential" mode and Raptor's
block histograms). Make that pass run in a Worker, feed it a windowed/overview read, and keep every
accumulator in `Float64Array`/`Uint32Array`.

---

## 1. Same-category approaches and competing tools

| Approach | Core idea | Wins when | Known drawbacks |
|---|---|---|---|
| **COG + HTTP range requests** ([spec](https://github.com/cogeotiff/cog-spec/blob/master/spec.md), [cogeo.org](https://cogeo.org/)) | All IFDs + tile index at file head, smallest overview first; client GETs only the byte ranges it needs (RFC 7233). Reading a tile downloads only the 16 KB blocks intersecting it; a 4096² image with 4 overview levels fits all 5 IFDs in the first **6 KB**. | Data is remote *and* already COG-structured; progressive display. | Useless for an arbitrary local TIFF (strips, no overviews, weird chunk sizes). Needs range-capable serving. |
| **geotiff.js** ([README](https://github.com/geotiffjs/geotiff.js)) | Pure-JS TIFF parser: strips/tiles, LZW/Deflate/JPEG/ZSTD/LERC, overview auto-selection, `readRasters({window, samples, width, height, resampleMethod, pool})`, worker `Pool`. v3 added deferred IFD tags + on-demand `loadValueIndexed` for huge `TileOffsets`. | Local file via `fromBlob`, no server, broad format support. | [#179](https://github.com/geotiffjs/geotiff.js/issues/179): on a 10k×12k TIFF a 64×64 window was as slow as a full decode, and repeat calls stayed slow. [#479](https://github.com/geotiffjs/geotiff.js/issues/479): pre-v3 `getImage()` on a 7 GB heavily-tiled COG downloaded **~500 MB** of `TileOffsets`/`TileByteCounts`. [#402](https://github.com/geotiffjs/geotiff.js/issues/402): ArrayBuffer hard cap **4 GB**. [#203](https://github.com/geotiffjs/geotiff.js/issues/203) LZW OOM. [#548](https://github.com/geotiffjs/geotiff.js/issues/548): no API to know how many bytes a read will pull. |
| **GDAL → WASM (gdal3.js, gdal-async, whitebox-wasm)** ([gdal3.js docs](https://gdal3.js.org/docs/), [geolibre-rust](https://github.com/opengeos/geolibre-rust)) | Emscripten build of GDAL+PROJ+GEOS: `gdal_translate/ogr2ogr/gdal_rasterize/gdalwarp` in-page. | You want GDAL's real polygon-rasterization and warp code without a server. | gdal3.js docs state it **"doesn't work with web worker"** and native bindings are faster; bundle is tens of MB; wasm32 caps heap at **4 GB** ([V8](https://v8.dev/blog/4gb-wasm-memory)); Wasm is not native speed — [Jangda et al. ATC'19](https://www.usenix.org/conference/atc19/presentation/jangda) measured **45 % (Firefox) / 55 % (Chrome) slower than native on SPEC**, peaks 2.08×/2.5×. |
| **Zarr v3 + zarrita** ([core spec](https://zarr-specs.readthedocs.io/en/latest/v3/core/), [zarrita.js](https://github.com/manzt/zarrita.js), [ZEP0002 sharding](https://zarr.dev/zeps/accepted/ZEP0002.html)) | n-D chunked arrays over HTTP; sharding packs many chunks per object (example in ZEP0002: 10.3 M chunks → ~300 shards). `zarrita.js` implements v2+v3 and ZEP2 sharding; `zarr.js` is **unmaintained and itself recommends zarrita**. | Multi-band/datacube sources already in Zarr; chunk-aligned reads. | Your user's file is a `.tif`, not a Zarr store. Sharding *increases* the minimum read granularity. Random 2-D windows can touch many chunks. |
| **GPU render layers (deck.gl / kepler.gl / georaster-layer-for-leaflet / OL WebGL)** ([deck.gl perf](https://deck.gl/docs/developer-guide/performance), [luma.gl gpu-raster](https://luma.gl/docs/capabilities/gpu-data-compute)) | Raster as GPU texture, colour ramp in shader; polygons as GPU geometry. | Displaying the raster + thousands of polygons. | Rendering only, no zonal stats. deck.gl: ~1 M items at 60 FPS on 2015 MBP, **10–20 FPS near 10 M**, crashes between 10 M–100 M items because **Chrome caps a single allocation at 1 GB**. GPU-side statistics exist but are experimental (`@luma.gl/graph/gpu-raster`: nodata-aware stats, histograms, percentiles, NDVI). |
| **Tile servers (TiTiler / GeoServer / marblecutter)** ([titiler](https://github.com/developmentseed/titiler)) | Server decodes COG, reprojects, colourises, returns tiles. | You can run infrastructure. | Excluded here (no upload / browser-only); also adds latency per interaction. |
| **Google Earth Engine `reduceRegion`** (the baseline) ([docs](https://developers.google.com/earth-engine/guides/reducers_reduce_region)) | Rasterizes region in the image CRS, weights pixels by coverage. | Huge datasets, server parallelism. | **Pixel weights are 8-bit integers (0–255): any coverage < ~1/256 ≈ 0.4 % becomes weight 0 and can return `null`.** Replacing it means you inherit exactly this class of approximation question. |
| **geoblaze** ([docs](https://docs.geoblaze.io/)) | Pure-JS raster engine, in-browser zonal stats on top of georaster/geotiff.js. | Closest same-category JS reference implementation. | Inherits every geotiff.js decode/memory limit; not a fix by itself. |

---

## 2. Algorithms and engineering techniques (ranked for *this* raster)

1. **One-pass cell-ID rasterization + accumulation (highest leverage).** Rasterize the grid once to an
   `Int32Array` of cell ids aligned to the raster, then scan pixels once adding to `sums[id]`/`counts[id]`.
   Cost O(N_pixels) with a linear memory walk and tiny random writes into a ~160 KB accumulator
   (5 k cells × 16 B). This is the algorithmic core of [`exactextract`](https://isciences.github.io/exactextract/background.html)
   (ring traversal + covered-fraction per touched cell + point-in-polygon flood fill for untouched cells)
   and of Raptor's block histograms. **Replaces O(cells × pixels_per_cell) point-in-polygon**, which for
   3 k cells can mean re-visiting the same pixels thousands of times.
2. **Window-limited decode** — `image.readRasters({window})` / `tiff.readRasters({bbox, resX, resY})` + the
   right overview level. Only helps if the layout cooperates ([#179](https://github.com/geotiffjs/geotiff.js/issues/179)).
3. **Workers + transferable ArrayBuffers** — decode and aggregate off the main thread; post the typed array
   with `postMessage(buf, [buf])` (zero-copy). geotiff.js already ships a worker `Pool` ([README](https://github.com/geotiffjs/geotiff.js)).
4. **Chunked row-band scanning** to bound peak memory: process e.g. 512–2048 rows at a time; only
   accumulators persist. Keeps peak well under the ArrayBuffer ceiling.
5. **Sparse/nodata masks** — skip nodata/NaN in the inner loop; keep `count` per cell so the mean divides by
   valid pixels only (the project's stated semantics).
6. **Overview levels** (`gdaladdo`, [docs](https://gdal.org/en/stable/programs/gdaladdo.html)) — a level whose
   pixel size ≈ grid-cell size gives an instant first estimate; refine at full res. Error is bounded and
   measurable (§3).
7. **WASM/SIMD inner loop** — [WebTensor (BTW 2023)](https://doi.org/10.18420/BTW2023-75) measured a Wasm
   build beating the Emscripten-compiled JS *from the same C++*: **+21 % point access, +92 % average dicing,
   +294 % average aggregation**. Medium effort, largest single compute win available without GPU portability risk.
8. **WebGL/WebGPU compute** — real gains for per-pixel math: TensorFlow.js diffusion **3× faster WebGPU vs
   WebGL**; marching cubes 8 FPS (JS) → 60 FPS (compute shader); Babylon render bundles **>10×** fewer
   submission calls ([Chrome](https://developer.chrome.com/blog/webgpu-io2023)). Readback of only 5 k
   accumulators is cheap. But: WebGPU availability, float-texture/storage-buffer constraints, and a second
   implementation to maintain. Do this *after* the CPU/Worker path.
9. **Integral image / summed-area table** — O(1) axis-aligned rectangle sums, but 2× `Float64Array` =
   **800 MB for 100 M pixels**, and it cannot express polygon-clipped cells. Not worth it at this scale.
10. **Spatial index (R-tree/quadtree/k-d)** — only needed on the vector-driven path (find cells overlapping a
    raster block). The rasterization approach makes it largely unnecessary; see [Zhang & You 2013](https://doi.org/10.1080/13658816.2013.828840) for GPGPU quadtree construction.
11. **OffscreenCanvas** — relevant only if *you* draw rasters/heatmaps; OL keeps owning the map canvas ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas)).
12. **Incremental/progressive rendering** — stream per-tile grid results into the layer as chunks finish,
    with `AbortController` cancellation (geotiff.js supports abort signals).
13. **SharedArrayBuffer** — removes copies but requires `crossOriginIsolated` (COOP/COEP headers); the
    transferable path usually suffices ([MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)).

---

## 3. Zonal statistics specifics

**Standard GIS pipeline.** GDAL 3.12 added [`gdal raster zonal-stats`](https://gdal.org/en/stable/programs/gdal_raster_zonal_stats.html)
(and the `GDALZonalStats()` C API): `--pixels default|fractional|all-touched`, `--strategy feature|raster`,
`--chunk-size` default **5 % of the raster**, `--weights` raster for weighted means. The classical recipe is
`gdal_rasterize` zone ids + `gdalwarp` alignment + stats; Python splits between `rasterstats`
(rasterize + centroid/`all_touched`) and [`exactextract`](https://isciences.github.io/exactextract/background.html)
(true per-cell coverage fraction via GEOS). GRASS does it with `r.univar` / `r.stats.zonal`
([manual](https://grass.osgeo.org/grass-stable/manuals/r.univar.html)); PostGIS with
`ST_SummaryStats` + `ST_Clip` ([docs](https://postgis.net/docs/en/RT_ST_SummaryStats.html)) — note
`ST_SummaryStats` accepts `sample_percent` for approximate results, and the official example clips band 2 to
3 Boston buildings in **574 ms** across ~134 000 tiles.

**Exact vs approximate (measured).** A reproducible benchmark on real data
([TechnicalGIS, Oct 2026](https://www.technicalgis.com/tutorials/zonal-statistics-python/)): coverage-weighted
vs centroid sums differ by a **median 4.0 % for zones < 0.5 km², 2.2 % for 0.5–2 km², 1.2 % for 2–10 km²,
0.4 % for > 10 km²**; `all_touched=True` inflated a national population sum by **+36.7 %** (every boundary
pixel counted in full by both neighbours); `exactextract` was **1.2× faster for sums and 1.9× faster for
means**, while `rasterstats` was faster for categorical fractions on a 258 M-cell raster (6.5 s vs 10.5 s).
The peer-reviewed treatment of this bias is [Markakis et al., IJGI 2026, "When Centroids Mislead"](https://doi.org/10.3390/ijgi15060244).

**Where time actually goes.** `exactextract`'s own profiling: for compressed rasters, **raster I/O > pixel
intersection > statistics** ([performance page](https://isciences.github.io/exactextract/performance.html)).
Its chunk-size experiment is the most transferable number here: the same task took **24 min 20 s** with
whole-grid chunks, **13 s** after rechunking to scanlines, **10 s** with 256×256 tiles — a >100× swing caused
purely by I/O layout. Increasing raster resolution **120×** raised runtime only **45 %** once there were ~2 M
polygons (I/O amortized). Default `max_cells_in_memory` is **30 M cells**.

**Exact vs approximate mean over a cell.** Mean-of-pixel-centres is an *unweighted* estimator;
area-weighted (portion of each boundary cell inside the cell) is the exact integral. For a farm prescription
grid where cells are much larger than pixels, only boundary cells matter. Recommended policy: assign interior
pixels by grid rasterization; for cells only partially covered, accumulate coverage-weighted fractions for
the boundary ring only (cheap, perimeter-bounded), and store both `mean_centroid` and `mean_weighted` so the
agronomist can see the delta. Compute in `Float64Array` — summing 100 M float32 values in float32 loses
precision badly. Also beware GEE's 1/256 quantization: sub-pixel cells can silently become `null`
([GEE docs](https://developers.google.com/earth-engine/guides/reducers_reduce_region)).

---

## 4. Papers and primary literature (all verified via Crossref/SOS unless noted)

1. **Possibilities of using raster data in client-side web maps** — G. Farkas — *Transactions in GIS* 24(1), 2020 — [10.1111/tgis.12588](https://doi.org/10.1111/tgis.12588) — the reference study on moving GeoTIFF parsing/rendering into the browser with OpenLayers; documents both the texture and hybrid vector-rendering strategies.
2. **Performance-improving techniques in web-based GIS** — C. Yang, D. Wong, R. Yang, M. Kafatos — *IJGIS* 19(3), 2005 — [10.1080/13658810412331280202](https://doi.org/10.1080/13658810412331280202) — canonical catalogue of WebGIS bottlenecks (client caching, data reduction, tile pyramids).
3. **Geospatial Analysis in Web Browsers — Comparison Study on WebGIS Process-Based Applications** — R. Netek, T. Pohankova, O. Bittner — *ISPRS IJGI* 12(9):374, 2023 — [10.3390/ijgi12090374](https://doi.org/10.3390/ijgi12090374) — empirical client-side processing comparison; useful for cost/benefit of in-browser vs server.
4. **Distributed zonal statistics of big raster and vector data** — S. Singla, A. Eldawy — *ACM SIGSPATIAL 2018* — [10.1145/3274895.3274985](https://doi.org/10.1145/3274895.3274985) — introduces the partition-based zonal-stats algorithm and shows why point-in-polygon and full rasterization baselines lose.
5. **Raptor Zonal Statistics: Fully Distributed Zonal Statistics of Big Raster + Vector Data** — S. Singla, A. Eldawy — *IEEE BigData 2020* — [10.1109/bigdata50022.2020.9377907](https://doi.org/10.1109/bigdata50022.2020.9377907) — cost model + evaluation to a trillion pixels; up to **two orders of magnitude** faster than Rasdaman and Earth Engine.
6. **High-Performance Zonal Histogramming on Large-Scale Geospatial Rasters Using GPUs and GPU-Accelerated Clusters** — J. Zhang, D. Wang — *IEEE IPDPSW 2014* — [10.1109/ipdpsw.2014.113](https://doi.org/10.1109/ipdpsw.2014.113) — four-step GPU pipeline (block histograms → block/polygon pairing → aggregation → point-in-polygon on intersect blocks); 20 B+ SRTM cells over 3000+ counties in **101 s cold / 46 s hot** on a GTX Titan.
7. **High-performance quadtree constructions on large-scale geospatial rasters using GPGPU parallel primitives** — J. Zhang, S. You — *IJGIS* 27(11), 2013 — [10.1080/13658816.2013.828840](https://doi.org/10.1080/13658816.2013.828840) — spatial-index construction on rasters; relevant if you keep a vector-driven path.
8. **Efficient histogramming of large-scale geospatial rasters in support of web-based queries** — S. You, J. Zhang — *ACM SIGSPATIAL BigSpatial 2011* — [10.1145/2070770.2070779](https://doi.org/10.1145/2070770.2070779) — early formulation of serving raster statistics to thin clients.
9. **GPU utilization in geoprocessing big geodata: a review** — S. Saupi Teri, I. A. Musliman, A. Abdul Rahman — *ISPRS Archives* XLVI-4/W3-2021, 2022 — [10.5194/isprs-archives-XLVI-4-W3-2021-295-2022](https://doi.org/10.5194/isprs-archives-XLVI-4-W3-2021-295-2022) — survey of which raster analytics have credible GPU speedups and where transfers dominate.
10. **When Centroids Mislead: Quantifying the Consequences of Sub-Optimally Aggregating Gridded Raster Data to Polygons** — P. J. Markakis, J. M. Malof, L. Collins, K. Bradbury — *ISPRS IJGI* 15(6):244, 2026 — [10.3390/ijgi15060244](https://doi.org/10.3390/ijgi15060244) — directly quantifies the centroid-vs-coverage error your grid will incur.
11. **MapLibre-RS: toward portable map renderers** — M. Ammann, A. Drabble, J. Ingensand, B. Chapuis — *ISPRS Archives* XLVIII-4/W1-2022 — [10.5194/isprs-archives-XLVIII-4-W1-2022-35-2022](https://doi.org/10.5194/isprs-archives-XLVIII-4-W1-2022-35-2022) — Rust→WASM/WebGPU map renderer; evidence for the WASM-renderer direction and its costs.
12. **Vector Data Rendering Performance Analysis of Open-Source Web Mapping Libraries** — D. Balla, M. Gede — *ISPRS IJGI* 14(9):336, 2025 — [10.3390/ijgi14090336](https://doi.org/10.3390/ijgi14090336) — head-to-head render throughput for large vector overlays (Leaflet/OpenLayers/MapLibre); the number to cite before assuming OL handles thousands of styled polygons.
13. **Google Earth Engine: Planetary-scale geospatial analysis for everyone** — N. Gorelick, M. Hancher, M. Dixon, et al. — *Remote Sensing of Environment* 202, 2017 — [10.1016/j.rse.2017.06.031](https://doi.org/10.1016/j.rse.2017.06.031) — the server-side baseline the project is replacing.
14. **Zonal Statistics** (ch. 24) — S. Winsemius, J. Braaten — in *Cloud-Based Remote Sensing with Google Earth Engine*, Springer, 2023 — [10.1007/978-3-031-26588-4_24](https://doi.org/10.1007/978-3-031-26588-4_24) — teaches the scale/CRS/weight pitfalls of zonal reductions explicitly.
15. **WebTensor: Towards high-performance raster data analysis in the browser** — L. F. Naumann — *BTW 2023*, LNI — [10.18420/BTW2023-75](https://doi.org/10.18420/BTW2023-75) — chunked Wasm tensor for browser raster analysis; the +21 %/+92 %/+294 % Wasm-vs-JS numbers come from here.

Additional cited primary sources (not counted above): [Jangda et al., USENIX ATC 2019](https://www.usenix.org/conference/atc19/presentation/jangda) (Wasm vs native);
[Poss et al., *Smart Agric. Tech.* 2025](https://doi.org/10.1016/j.atech.2025.100870) (ISO 11783-compliant vineyard VRA prescription maps);
[Zhao et al., *Front. Plant Sci.* 2025](https://doi.org/10.3389/fpls.2025.1621080) (orchard VRA spraying);
[Andrea et al., *J. Cotton Res.* 2025](https://doi.org/10.1186/s42397-024-00204-y) (supervised/unsupervised zonal application maps for VRA);
[Chrome WebGPU blog](https://developer.chrome.com/blog/webgpu-io2023); [exactextract performance docs](https://isciences.github.io/exactextract/performance.html).

**Unverified / not openable from this environment (do not cite as read):** a Linköping University master's
thesis (`diva2:1674422`) was returned by search with a gdal3.js-vs-native benchmark table, but the full text
did not download here; treat its numbers as unconfirmed.

---

## 5. Concrete recommended plan

**Quick wins (this week)**
1. **Instrument first.** Log bytes fetched, decode ms, aggregation ms, peak `performance.memory`/`measureUserAgentSpecificMemory`. Expect decode + over-read to dominate; verify before optimizing arithmetic.
2. **Windowed + overview-aware reads.** Require the fence bbox, `samples: [band]`, and `tiff.readRasters({bbox, resX, resY})` to pick a suitable overview. Expected: skip 60–95 % of pixels when the fence is a fraction of the image. Low cost. Risk: strips/untiled sources still decode fully ([#179](https://github.com/geotiffjs/geotiff.js/issues/179)) — detect tiling at open time and warn.
3. **Upgrade to geotiff.js v3** (deferred IFD tags). Pre-v3 fetched ~500 MB of metadata on a 7 GB tiled COG ([#479](https://github.com/geotiffjs/geotiff.js/issues/479)). Low cost, direct win on tiled inputs.
4. **Dedicated Worker + transferable ArrayBuffers** for decode+aggregate; keep main thread for OL. Transfer the accumulator/results back zero-copy. Low–medium cost. Risk: Vite worker bundling.
5. **Replace per-cell point-in-polygon with one-pass cell-ID accumulation.** Medium cost, typically 10–100× on aggregation; removes the O(cells × pixels) blowup entirely. Risks: correct cell-id alignment, nodata handling, and an explicit documented rule for boundary pixels.
6. **Bound memory explicitly:** scan in row bands (512–2048 rows), accumulators only (`Float64Array` sums + `Uint32Array` counts; 5 k cells ≈ 160 KB). Never hold the file buffer + full decoded raster + grid + GeoJSON simultaneously.

**Architectural (next 2–6 weeks)**
7. **Wasm inner loop** (Rust/C++ or wasm-SIMD) for the accumulate pass — target **~2–4×** on compute based on WebTensor's +294 % average aggregation win. Medium cost; keeps one code path if the Wasm module is generated from the same algorithm.
8. **Two-tier result:** coarse overview pass for instant prescription, full-res refine with a cancelable job. `exactextract` shows resolution is a weak lever once I/O is chunked (120× resolution → +45 % runtime at ~2 M polygons), so the coarse level should be chosen to match cell size.
9. **Coverage-weighted boundary cells only** (exactextract-style ring traversal, perimeter-bounded) for defensible means, with `mean_centroid` retained for comparison.
10. **WebGPU compute path** behind a feature check, once 1–9 are done (`navigator.gpu` + a CPU fallback). Reported upside: 3× (WebGL→WebGPU ML), 8→60 FPS compute-shader cases.
11. **Export as tiled + overviewed GeoTIFF/COG** and stream the GeoJSON (or offer FlatGeobuf/GeoJSONSeq) rather than serializing one giant string.

---

## 6. Known pitfalls and caveats

- **Reproject the fence/grid, never the raster.** Reprojecting a few thousand vertices is cheap; warping a raster resamples every cell and changes totals unless you use sum resampling. The classic failure: mismatched CRS made `rasterstats` try to allocate **120 TiB**, while `exactextract` silently returned zeros ([TechnicalGIS](https://www.technicalgis.com/tutorials/zonal-statistics-python/)).
- **proj4 per-pixel transforms are the #1 self-inflicted cost.** Do all grid math in the raster CRS after a single vector reprojection; only re-project the final output geometry.
- **GeoJSON blowup.** Full-precision coordinates plus properties are typically ~100–300 bytes per vertex; a few thousand polygons can produce tens of MB of text and a second full copy in memory. Round coordinates, stream the writer, or offer FlatGeobuf.
- **OpenLayers polygon rendering.** Thousands of individually styled features are the OL cost driver; the OL project ships a [Canvas-vs-WebGL polygon rendering benchmark](https://openlayers.org/bench/) precisely for this. Prefer one style function, reuse sources, and consider a WebGL/heatmap-style representation for the grid. deck.gl-style limits: **1 GB max single allocation in Chrome**, crashes at 10 M–100 M items.
- **Memory ceilings are lower than the spec.** ArrayBuffer max **4 GB** ([geotiff.js #402](https://github.com/geotiffjs/geotiff.js/issues/402)); wasm32 heap max **4 GB** ([V8](https://v8.dev/blog/4gb-wasm-memory)); mobile is far worse (page reloads under memory pressure). A 100 M-pixel float32 raster is already 400 MB before duplicates.
- **geotiff.js specifics:** `fromBlob`/`fromArrayBuffer` can load the whole file; BigTIFF support is explicitly "limited" (no real 64-bit typed arrays); LZW decoding has known OOM reports; `readRasters` has no pre-flight byte estimate ([#548](https://github.com/geotiffjs/geotiff.js/issues/548)).
- **Worker pool sizing.** `Pool` defaults to `hardwareConcurrency`; adding your own decode pool plus an aggregation worker on top oversubscribes and stalls the machine. Cap decode workers at `min(4, hardwareConcurrency − 1)` and reuse pools rather than constructing per read.
- **SharedArrayBuffer needs cross-origin isolation** (COOP/COEP); plan for the transferable-ArrayBuffer path as the default.
- **Float precision.** Accumulate in `Float64Array`. Summing 100 M float32 values in float32 accumulates visible error; likewise never store `-9999`/NaN into sums — mask first, using the band's nodata tag / `GDAL_NODATA`.
- **Sub-pixel and quantization traps.** GEE's 8-bit coverage weights mean any cell covering <0.4 % of a pixel can vanish to `null`; if your grid can produce cells smaller than a pixel at the source resolution, choose the read resolution deliberately.
