# GeoTIFF Fence Grid Tool

[中文](README.md) · **English**

A browser-based tool for precision-agriculture operations: load a GeoTIFF scene, draw an electronic fence on the map, generate a spatial grid, aggregate pixel values per grid cell, and export both GeoJSON and a clipped prescription GeoTIFF that can be handed straight to field machinery. Imagery is parsed locally and never uploaded.

![Stack](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)
![Stack](https://img.shields.io/badge/TypeScript-5.8-3178c6?logo=typescript&logoColor=white)
![Stack](https://img.shields.io/badge/Vite-6-646cff?logo=vite&logoColor=white)
![Map](https://img.shields.io/badge/OpenLayers-10-1f6feb)
![License](https://img.shields.io/badge/license-MIT-green)

> The user interface is currently Chinese-only; the screenshots below show the actual application.

## Table of contents

- [Screenshots](#screenshots)
- [Highlights](#highlights)
- [Typical workflow](#typical-workflow)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Project layout](#project-layout)
- [Modules at a glance](#modules-at-a-glance)
- [Performance](#performance)
- [Testing](#testing)
- [FAQ](#faq)
- [Roadmap](#roadmap)
- [License](#license)

## Screenshots

### Full workflow: fence + grid + aggregated results

![Fence, grid and aggregated results](docs/images/03-fence-grid-workflow.png)

Grid size, rotation and classification are configured on the left; the map renders the scene, the fence outline and the colour-coded grid; the right panel reports fence area, hit-cell count and the hovered pixel/grid mean value.

<details>
<summary>More screenshots</summary>

### Start screen

![Start screen](docs/images/01-start-screen.png)

| Scene loaded | Results and hover info |
| --- | --- |
| ![GeoTIFF loaded](docs/images/02-geotiff-loaded.png) | ![Result panel](docs/images/04-result-panel.png) |

![Map detail](docs/images/05-map-detail.png)

</details>

## Highlights

- **GeoTIFF loading and inspection**: reads large scenes locally; extracts CRS, resolution, bounding box and band count; renders a preview first and builds the valid-data (nodata) mask asynchronously.
- **Electronic fence**: draw, edit and clear polygon fences on the map; the fence is clipped to the scene and valid-data extent with validation hints; area, vertex count and bounds are reported.
- **Spatial grid and aggregation**: real-time grid generation by physical cell size, with rotation and mean/max/min aggregation; cells are selected by a centre-hit rule; the minimum cell size follows the scene resolution; map preview, hover info and exports share one aggregation result.
- **Classification and variable rate**: single-band scenes support rule-based and gradient colouring, multiple schemes with copy/switch/visibility, and a built-in NDVI default; each rule carries a colour, label and application rate, with coverage area and estimated total summed per class.
- **Export**: fence/grid GeoJSON (with aggregated values and `fertilizerAmount`), plus a clipped prescription GeoTIFF where each cell's aggregated value is written back to its pixels, non-hit areas become NoData, and an extra prescription band is appended when rules are active. Deflate compression is applied by default.
- **Works with large files**: scene parsing and heavy computation run in Web Workers, with a main-thread fallback when a Worker is unavailable; grids with tens of thousands of cells render through WebGL and are sampled above the render budget (hover and export still cover every cell).

## Typical workflow

1. Pick a GeoTIFF in the left panel; metadata is parsed and a map preview is generated.
2. Click “Start drawing”, add vertices with single clicks and close the fence by returning to the start point (double-click also works); the fence is clipped to the valid-data extent.
3. Set the grid cell size and rotation (optionally switch classification scheme and application rate); the grid preview and pixel aggregation update live.
4. The map and right panel show grid statistics, classification results and estimated prescription amounts; hover for pixel value, class range and grid mean.
5. Export the fence GeoJSON, grid GeoJSON or the clipped prescription GeoTIFF from the top bar.

## Tech stack

| Area | Choice |
| --- | --- |
| Framework | React 19 + TypeScript + Vite 6 |
| State | Zustand 5 |
| Map rendering | OpenLayers 10 (grid layer on WebGL) |
| Raster parsing | geotiff.js |
| Geospatial maths | Turf.js + Proj4js |
| Testing | Vitest + Testing Library |

## Getting started

Requires Node.js 18+ and pnpm.

```bash
pnpm install    # install dependencies
pnpm dev        # start the dev server
```

Open <http://localhost:5173>. The dev server binds to loopback only; add `--host` if you need LAN access.

Any local GeoTIFF works (single- or multi-band, with `GDAL_NODATA` or a zero background). Load it from “File information” in the left panel via “Select TIFF file”.

### Available scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the Vite dev server |
| `pnpm build` | Type-check (`tsc --noEmit`) and build for production |
| `pnpm preview` | Preview the production build |
| `pnpm test` | Run the whole Vitest suite |

## Project layout

```text
src/
├── app/                  # three-column shell, styles, entry point
├── features/
│   ├── map/              # map instance, layers, loading pipeline, interactions
│   ├── fence/ grid/      # fence and grid state
│   ├── export/           # GeoJSON / GeoTIFF export
│   ├── project/          # project snapshots and drafts
│   └── loading/          # global loading state
└── shared/
    ├── geo/              # pure geospatial maths: CRS, fence, grid, aggregation, GeoTIFF I/O
    ├── workers/          # worker tasks, request builders, registry
    └── hooks/ types/     # shared hooks and type contracts

tests/                    # unit and component tests (bench/ holds the aggregation equivalence benchmark)
docs/                     # design notes, performance research, screenshots
```

## Modules at a glance

| Module | Responsibility | Key files |
| --- | --- | --- |
| Raster intake | File selection, metadata, preview, valid-data mask | [rasterIo.ts](src/shared/geo/rasterIo.ts), [useRasterLoader.ts](src/features/map/useRasterLoader.ts) |
| Map workspace | Scene/fence/grid rendering, view fitting, hover feedback | [useMap.ts](src/features/map/useMap.ts), [mapUtils.ts](src/features/map/mapUtils.ts) |
| Fence | Drawing, editing, validation, clipping, summary | [fence.ts](src/shared/geo/fence.ts) |
| Grid and aggregation | Grid generation, rotation, pixel aggregation, O(1) hit lookup | [grid.ts](src/shared/geo/grid.ts), [gridAggregation.ts](src/shared/geo/gridAggregation.ts) |
| Classification and prescriptions | Rule/gradient colouring, rate mapping, statistics | [rasterClassification.ts](src/shared/geo/rasterClassification.ts), [applicationRate.ts](src/shared/geo/applicationRate.ts) |
| Export | Fence/grid GeoJSON, prescription GeoTIFF | [exportGeoTiff.ts](src/features/export/exportGeoTiff.ts), [geotiffWriter.ts](src/shared/geo/geotiffWriter.ts) |
| Project snapshots | Serialising, validating and restoring recipes, plus local drafts | [projectSnapshot.ts](src/features/project/projectSnapshot.ts), [draftStorage.ts](src/features/project/draftStorage.ts) |
| Background compute | Worker tasks, window decode cache, registry | [rasterWorkerTasks.ts](src/shared/workers/rasterWorkerTasks.ts) |

Layering: `app` owns layout and entry orchestration, `features` holds business state and flows, `shared/geo` is a UI-free computation layer, and `shared/workers` only contains offloadable pure tasks.

## Performance

Numbers below are measured on a real scene (5647×3179) in a local Chromium build; the harness is in [tests/bench](tests/bench/grid-aggregation.test.ts):

| Step | Before | Now |
| --- | --- | --- |
| Grid aggregation (4.49M-pixel window) | 403–447 ms | **6.4–8.5 ms** |
| One parameter change (cell size / rotation / mode) | ~375 ms (re-decodes the window every time) | **~13 ms** (decode cache hit) |
| Export size (2.56M-pixel prescription) | 49.3 MB | **0.13 MB** (Deflate) |
| Export time on the main thread | ~0.5 s frozen | **0** (runs in a Worker) |
| Pan/zoom with 54.6k cells (89 input events) | main thread 1.7 s / script 1.57 s | **main thread 0.28–0.64 s / script 0.09–0.32 s** |
| Large-file memory | one full file buffer resident per thread | bounded LRU (at most 2 scenes); the main thread no longer reads the file |

The last row is main-thread CPU for the same drag-and-zoom script (wall-clock time is unusable here because an automated window gets throttled); above the render budget the map renders a sampled subset, so that row covers both the rendering change and the sampling policy.

What made the difference:

- **Aggregation**: pixel columns are merged into runs per grid column and accumulated per run, with `Float64Array` sums, `Uint32Array` counts and per-row/column metric lookups replacing per-pixel metric math, division and string-keyed lookups.
- **Decoding**: fence windows are cached per window inside the Worker (LRU, 2 windows), so grid parameter changes no longer re-decode.
- **Rendering**: the grid layer uses OpenLayers `WebGLVector` with colours stored as feature properties; above 50k cells it renders a sampled subset while hover still queries the full grid.
- **Export**: Float32 output and a single TIFF assembly buffer, with native `CompressionStream` for Deflate and a transparent fallback to uncompressed output.
- **Memory**: `RasterSession` instances are keyed by content fingerprint and bounded by LRU; metadata and embedded recipes are read inside the Worker so the main thread never holds the file buffer.

Related tools, papers and follow-up ideas: [docs/raster-zonal-stats-perf-brief.md](docs/raster-zonal-stats-perf-brief.md).

## Testing

```bash
pnpm test    # run the whole suite
```

Coverage includes geospatial maths (CRS, fence, grid, aggregation, metric transforms, GeoTIFF writing and export), state management, project snapshots and drafts, and the main UI flows. Worker task implementations are separate from the thread wrapper, so aggregation, metadata, embedded recipes and export paths are unit-testable.

[tests/bench/grid-aggregation.test.ts](tests/bench/grid-aggregation.test.ts) keeps a reference implementation of the previous approach and verifies the current kernel cell by cell across randomised parameters (rotation, holes, geographic CRS, negative resolution, nodata), printing a timing comparison as it goes.

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs `pnpm install --frozen-lockfile`, `pnpm build` and `pnpm test` on Node.js 22 + pnpm 10.

## FAQ

**“The fence must fall inside the valid data area.”**
Draw the fence inside the valid-data extent (avoiding transparent/nodata edges). Click “Fit scene” first, then draw along the inside of the valid area.

**No grid cells, or the grid is not coloured?**
Check whether the cell size is much larger than the fence, and whether the fence overlaps valid data. A hover readout of `--` for “grid hit” means no cell covers that position.

**Only part of the grid is drawn when there are many cells?**
Above 50k cells the map renders a sampled subset and the hint in the results panel reports the sampled count. Hover and export still cover every cell, so results are unaffected.

**Why is the exported GeoTIFF `Float32`?**
With classification rules enabled an application-rate prescription band is written, so bands are promoted to `Float32`; without rules the source data type is kept where possible.

**Why is the exported file much smaller than the scene?**
Every grid cell holds one value, so the pixel data is highly repetitive. Output is Deflate-compressed (TIFF `Compression=8`), which takes 49 MB down to roughly 0.1 MB in our measurements. If `CompressionStream` is unavailable the writer falls back to uncompressed output with identical values.

**The page feels sluggish.**
Check scene size and grid density first. Large grids are only sampled for rendering, but extreme parameter combinations are still best avoided.

## Roadmap

Already supported: three-column workbench and map integration, GeoTIFF parsing and rendering, fence drawing/editing/clipping, grid rotation and aggregation, classification layers with rate estimation, fence/grid GeoJSON and prescription GeoTIFF export, project snapshot save/open with embedded recipes, vegetation-index panel, multi-CRS detection and reprojection, Worker-based parsing and computation, WebGL rendering for large grids.

Planned:

- [ ] Multi-fence queues and batch export
- [ ] Chunked reading for very large scenes and finer memory limits
- [ ] Online imagery (COG / HTTP Range) support
- [ ] Optional uncompressed export for terminals that only read uncompressed TIFF

## License

Released under the [MIT License](LICENSE), Copyright (c) 2026 ttot contributors.
