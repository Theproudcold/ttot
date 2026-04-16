# Rendering Performance Optimization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate rendering jank, remove repeated GeoTIFF decode work, and make map interaction stay responsive under large rasters and dense grids.

**Architecture:** Fix the pipeline in dependency order instead of applying isolated micro-optimizations. First establish measurement and gate noisy debug output, then introduce a single-decode `RasterSession` shared across metadata/preview/mask/window/export flows, then move pointer interaction and grid lookup off obvious hot loops, and finally offload heavy raster/grid computation to a worker so the main thread only paints and handles UI.

**Tech Stack:** React 19, Zustand 5, OpenLayers 10, TypeScript, Vite

---

## File Structure

| File | Change Type | Responsibility |
|------|-------------|---------------|
| `src/shared/geo/rasterSession.ts` | **Create** | Open a source once and reuse `ArrayBuffer` / `GeoTIFF` / `GeoTIFFImage` handles |
| `src/shared/hooks/useRafThrottle.ts` | **Create** | Reusable rAF-based throttle hook |
| `src/shared/geo/gridLookup.ts` | **Create** | O(1) grid cell spatial lookup |
| `src/shared/workers/rasterCompute.worker.ts` | **Create** | Run preview recoloring and grid aggregation off the main thread |
| `src/features/map/debugLogger.ts` | Modify | Gate debug logs behind env checks and expose lightweight timing helpers |
| `src/features/map/useRasterLoader.ts` | Modify | Coordinate phased loading around `RasterSession` and record timings |
| `src/features/map/rasterStore.ts` | Modify | Hold lightweight source lifecycle state without duplicating heavy payloads |
| `src/features/map/useMap.ts` | Modify | Throttle pointermove, use grid lookup, cache styles, consolidate ref syncs |
| `src/features/grid/gridStore.ts` | Modify | Store grid origin metadata, remove unnecessary spread |
| `src/features/map/MapView.tsx` | Modify | Derive hoverInfo-related values outside render |
| `src/app/layout/RightPanel.tsx` | Modify | Memoize grid rule match computations |
| `src/shared/types/raster.ts` | Modify | Add worker/session result types where needed |
| `src/shared/geo/geotiffExport.ts` | Modify | Reuse existing raster session/window reads instead of reopening files |
| `src/shared/geo/grid.ts` | Modify | Return grid origin for spatial lookup |
| `src/shared/geo/raster.ts` | Modify | Split pure raster helpers from session-backed loading functions |

---

## Execution Order

1. Instrument and measure first so later changes can be accepted or rejected with evidence.
2. Remove repeated source reads and repeated decode work before tuning render loops.
3. Reduce main-thread interaction cost (`pointermove`, lookup, panel recomputation).
4. Offload heavy preview recoloring and grid aggregation to a worker.
5. Apply secondary cleanup optimizations only after the first four steps are verified.

---

### Task 1: Establish a Performance Baseline and Gate Debug Output

**Impact:** HIGHEST — prevents blind optimization and cuts log noise that currently inflates dev-time interaction cost.

**Files:**
- Modify: `src/features/map/debugLogger.ts`
- Modify: `src/features/map/useRasterLoader.ts`
- Modify: `src/features/map/useMap.ts`

- [ ] **Step 1: Add environment-gated logging helpers**

In `src/features/map/debugLogger.ts`, add:

```typescript
const DEBUG_ENABLED = import.meta.env.DEV && import.meta.env.VITE_DEBUG_GEO === 'true';

export function debugLog(scope: string, message: string, payload?: unknown) {
  if (!DEBUG_ENABLED) {
    return;
  }

  const prefix = `[GeoTIFFDebug][${scope}] ${message}`;
  if (payload === undefined) {
    console.info(prefix);
    return;
  }

  console.groupCollapsed(prefix);
  console.info(payload);
  console.groupEnd();
}

export function markPerformanceStart(name: string) {
  if (typeof performance === 'undefined') {
    return;
  }

  performance.mark(`${name}:start`);
}

export function markPerformanceEnd(name: string) {
  if (typeof performance === 'undefined') {
    return;
  }

  performance.mark(`${name}:end`);
  performance.measure(name, `${name}:start`, `${name}:end`);
}
```

- [ ] **Step 2: Mark the three user-visible critical paths**

In `src/features/map/useRasterLoader.ts`, wrap:
- metadata read
- preview generation
- validity mask generation

with `markPerformanceStart/End`.

In `src/features/map/useMap.ts`, wrap:
- geometric grid preview build
- GeoTIFF fence window read
- aggregation build
- styled preview regeneration

with the same helpers.

Use stable measure names such as:

```typescript
markPerformanceStart('raster:metadata');
markPerformanceEnd('raster:metadata');

markPerformanceStart('grid:aggregation');
markPerformanceEnd('grid:aggregation');
```

- [ ] **Step 3: Keep the marks visible but non-invasive**

Do **not** add any new UI. Verification is through browser DevTools:
- `Performance` tab for frame time
- `performance.getEntriesByType('measure')` in console for quick sampling

- [ ] **Step 4: Verify the baseline instrumentation**

Run: `npm run build`
Expected: Build succeeds with no TypeScript or bundling errors

Manual check:
1. Start dev server with `VITE_DEBUG_GEO=true npm run dev`
2. Load a representative large TIFF
3. In DevTools console, run `performance.getEntriesByType('measure')`
Expected: named measures exist for raster loading and grid aggregation phases

---

### Task 2: Introduce a Single-Decode RasterSession

**Impact:** HIGHEST — removes repeated `readBlobBuffer` + `fromArrayBuffer` work across metadata, preview, validity mask, fence window reads, and export flows.

**Files:**
- Create: `src/shared/geo/rasterSession.ts`
- Modify: `src/shared/geo/raster.ts`
- Modify: `src/shared/geo/geotiffExport.ts`
- Modify: `src/features/map/useRasterLoader.ts`
- Modify: `src/features/map/rasterStore.ts`
- Modify: `src/shared/types/raster.ts`

- [ ] **Step 1: Create a session module that opens a source exactly once**

Create `src/shared/geo/rasterSession.ts`:

```typescript
import { fromArrayBuffer } from 'geotiff';

import { fetchRasterBuffer, readBlobBuffer } from '@/shared/geo/raster';

export type RasterSession = {
  sourceKey: string;
  arrayBuffer: ArrayBuffer;
  tiff: Awaited<ReturnType<typeof fromArrayBuffer>>;
  image: Awaited<ReturnType<Awaited<ReturnType<typeof fromArrayBuffer>>['getImage']>>;
};

const sessionCache = new Map<string, Promise<RasterSession>>();

export function buildRasterSourceKey(source: File | string): string {
  return typeof source === 'string'
    ? `url:${source}`
    : `file:${source.name}:${source.size}:${source.lastModified}`;
}

export function clearRasterSession(sourceKey: string) {
  sessionCache.delete(sourceKey);
}

export async function openRasterSession(source: File | string): Promise<RasterSession> {
  const sourceKey = buildRasterSourceKey(source);
  const cached = sessionCache.get(sourceKey);
  if (cached) {
    return await cached;
  }

  const sessionPromise = (async () => {
    const arrayBuffer =
      typeof source === 'string' ? await fetchRasterBuffer(source) : await readBlobBuffer(source);
    const tiff = await fromArrayBuffer(arrayBuffer);
    const image = await tiff.getImage();

    return {
      sourceKey,
      arrayBuffer,
      tiff,
      image,
    };
  })();

  sessionCache.set(sourceKey, sessionPromise);
  return await sessionPromise;
}
```

- [ ] **Step 2: Split `raster.ts` into pure transforms plus session-backed loaders**

In `src/shared/geo/raster.ts`:
- keep pure helpers such as `buildRasterMetadata`, `buildPreviewRgba`, `buildValidityMask`
- add `loadRasterMetadataFromSession(session, ...)`
- add `loadRasterPreviewFromSession(session, ...)`
- add `loadRasterValidityMaskFromSession(session, ...)`

Each of these must read from `session.image` instead of calling `fromArrayBuffer` again.

- [ ] **Step 3: Change `useRasterLoader` to open one session per `sourceId`**

In `src/features/map/useRasterLoader.ts`:
- call `openRasterSession(sourceFile)` once when loading starts
- reuse the resolved session across metadata, preview, and validity mask stages
- if `sourceId` changes, ignore prior results

Pattern:

```typescript
const sessionRef = useRef<RasterSession | null>(null);

openRasterSession(sourceFile).then((session) => {
  if (disposed) return;
  sessionRef.current = session;
  return loadRasterMetadataFromSession(session, ...);
});
```

- [ ] **Step 4: Reuse the session for fence-window reads and exports**

In `src/shared/geo/geotiffExport.ts`, change:

```typescript
export async function readGeoTiffFenceWindow(input: {
  file: File;
  fenceRings: FenceRings;
  samples?: number[];
}): Promise<GeoTiffFenceWindowData>
```

to accept either a `session` or a `file`:

```typescript
export async function readGeoTiffFenceWindow(input: {
  file?: File;
  session?: RasterSession;
  fenceRings: FenceRings;
  samples?: number[];
}): Promise<GeoTiffFenceWindowData>
```

Use `input.session?.image` when present. Only fall back to opening from `file` if no session is provided.

- [ ] **Step 5: Keep heavy objects out of Zustand state**

In `src/features/map/rasterStore.ts`, do **not** store `ArrayBuffer`, `tiff`, or `image` in the store.

The store should continue holding only lightweight UI state:
- `sourceFile`
- `sourceId`
- `metadata`
- `preview`
- statuses / errors / progress

The session lives in the module cache and/or refs inside hooks.

- [ ] **Step 6: Verify single-decode behavior**

Run: `npm run build`
Expected: Build succeeds

Manual check:
1. Load a TIFF
2. Trigger preview generation, validity mask generation, hover grid aggregation, and export
3. Confirm through temporary logging or performance entries that `openRasterSession` resolves once per `sourceId`

---

### Task 3: Add requestAnimationFrame Throttle for pointermove

**Impact:** HIGHEST — eliminates 60-90% of wasted pointermove computations with zero behavioral change.

**Files:**
- Create: `src/shared/hooks/useRafThrottle.ts`
- Modify: `src/features/map/useMap.ts:339-384`

- [ ] **Step 1: Create `useRafThrottle` hook**

```typescript
// src/shared/hooks/useRafThrottle.ts
import { useCallback, useRef } from 'react';

/**
 * Returns a throttled version of `callback` that fires at most once per animation frame.
 * The latest call within a frame wins; earlier calls are discarded.
 */
export function useRafThrottle<T extends (...args: never[]) => void>(
  callback: T,
): T {
  const rafIdRef = useRef(0);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  // eslint-disable-next-line react-hooks/rules-of-hooks -- we return a stable function
  return useCallback((...args: Parameters<T>) => {
    cancelAnimationFrame(rafIdRef.current);
    rafIdRef.current = requestAnimationFrame(() => {
      callbackRef.current(...args);
    });
  }, []) as T;
}
```

- [ ] **Step 2: Apply rAF throttle to pointermove handler in useMap.ts**

In `useMap.ts`, import `useRafThrottle` and wrap the `setHoverInfo`/`setPointerText` calls. The handler body stays the same; we just throttle the **state updates** that trigger re-renders.

Change the pointermove handler from directly computing and calling `setHoverInfo`/`setPointerText` to storing the latest event and processing it in a rAF callback.

At the top of the file, add:
```typescript
import { useRafThrottle } from '@/shared/hooks/useRafThrottle';
```

Replace lines 339-384 with a pattern that:
1. Stores `event.coordinate` in a ref on every pointermove (synchronous, cheap)
2. Uses rAF to process the stored coordinate and call `setHoverInfo` at most once per frame

```typescript
    const latestPointerCoordinateRef = useRef<[number, number] | null>(null);

    map.on('pointermove', (event) => {
      latestPointerCoordinateRef.current = event.coordinate as [number, number];
    });

    const processPointerMove = useRafThrottle(() => {
      const coordinate = latestPointerCoordinateRef.current;
      if (!coordinate) return;

      const currentMetadata = metadataRef.current;
      const currentPreview = previewRef.current;
      const currentValidityMask = validityMaskRef.current;
      const currentFence = fenceRef.current;
      const currentGridCells = gridCellsRef.current;

      const [x, y] = coordinate;
      const isDegree = currentMetadata?.cellSize.unit === 'degree';
      const decimals = isDegree ? 6 : 3;
      setPointerText(`${x.toFixed(decimals)}, ${y.toFixed(decimals)}`);

      if (!currentMetadata || !currentPreview) {
        setHoverInfo(null);
        return;
      }

      const sampleValues = getPreviewSampleValues(coordinate, currentMetadata, currentPreview);
      const primarySampleValue = getPrimarySampleValue(sampleValues, currentPreview.noDataValue);
      const hitGridCell = findGridCellAtCoordinate(coordinate, currentGridCells);
      const visibleClassificationLayer = visibleClassificationLayerRef.current;
      const classificationMatch =
        currentPreview.sampleBandCount === 1 && visibleClassificationLayer
          ? findRasterClassificationMatch(
              primarySampleValue ?? Number.NaN,
              visibleClassificationLayer,
            )
          : null;

      setHoverInfo({
        coordinate,
        pixel: getPixelPosition(coordinate, currentMetadata),
        sampleValues,
        classificationLayerName: visibleClassificationLayer?.label ?? null,
        classificationLabel: classificationMatch?.label ?? null,
        classificationColor: classificationMatch?.color ?? null,
        inValidityMask: currentValidityMask
          ? isCoordinateInValidityMask(coordinate, currentValidityMask)
          : null,
        inFence: currentFence ? isPointInFence(coordinate, currentFence.geometry.coordinates) : false,
        gridCellId: hitGridCell?.id ?? null,
        gridMeanValue: hitGridCell?.aggregation?.meanValue ?? null,
        gridValidPixelCount: hitGridCell?.aggregation?.validPixelCount ?? null,
      });

      latestPointerCoordinateRef.current = null;
    });

    // Schedule rAF processing on every pointermove
    map.on('pointermove', processPointerMove);
```

**Note:** The `useRafThrottle` hook must be called at the `useMap` hook level, not inside the map init useEffect. Move the hook call to the top of `useMap()`, and use `processPointerMove` inside the map init useEffect where pointermove is registered. Since `useRafThrottle` returns a stable function ref, it's safe to use in the useEffect dependency array.

- [ ] **Step 3: Verify no regressions**

Run: `npx tsc --noEmit`
Expected: No type errors

Run the app, move mouse over the map, verify hover card still updates smoothly (should feel identical but with less jank on large grids).

---

### Task 4: O(1) Grid Cell Spatial Lookup

**Impact:** HIGH — replaces O(n) `findGridCellAtCoordinate` with O(1) lookup. Critical for large grids (1000+ cells).

**Files:**
- Create: `src/shared/geo/gridLookup.ts`
- Modify: `src/features/grid/gridStore.ts`
- Modify: `src/shared/geo/grid.ts`
- Modify: `src/features/map/useMap.ts`

- [ ] **Step 1: Extend `buildGridPreview` to return grid origin and cellSize in metric space**

In `src/shared/geo/grid.ts`, add `metricOrigin` and `metricCellSize` to the returned `GridPreview`:

```typescript
// In the return value of buildGridPreview, add:
return {
  cells,
  summary: { ... },
  metricOrigin: [minX, minY] as [number, number],
  metricCellSize: cellSize,
};
```

Also update `src/shared/types/grid.ts` to add these fields to `GridPreview`:

```typescript
export type GridPreview = {
  cells: GridCell[];
  summary: GridSummary;
  metricOrigin: [number, number];
  metricCellSize: number;
};
```

- [ ] **Step 2: Create `gridLookup.ts`**

```typescript
// src/shared/geo/gridLookup.ts
import type { GridCell } from '@/shared/types/grid';
import type { MetricTransform } from '@/shared/geo/crs';

type GridLookupIndex = {
  cellsById: Map<string, GridCell>;
  metricOrigin: [number, number];
  metricCellSize: number;
  metricTransform: MetricTransform | null;
};

/**
 * Build a spatial lookup index from grid cells.
 * Enables O(1) coordinate → cell lookup via row/col computation.
 */
export function buildGridLookup(
  cells: GridCell[],
  metricOrigin: [number, number],
  metricCellSize: number,
  metricTransform: MetricTransform | null,
): GridLookupIndex {
  const cellsById = new Map<string, GridCell>();
  for (const cell of cells) {
    cellsById.set(cell.id, cell);
  }
  return { cellsById, metricOrigin, metricCellSize, metricTransform };
}

/**
 * Find the grid cell at a coordinate using O(1) row/col computation.
 * Returns null if no cell exists at that coordinate.
 */
export function findCellAtCoordinate(
  coordinate: [number, number],
  lookup: GridLookupIndex | null,
): GridCell | null {
  if (!lookup || !lookup.metricTransform) return null;

  const [metricX, metricY] = lookup.metricTransform.toMetric(coordinate);
  const col = Math.floor((metricX - lookup.metricOrigin[0]) / lookup.metricCellSize);
  const row = Math.floor((metricY - lookup.metricOrigin[1]) / lookup.metricCellSize);
  const cellId = `r${row}-c${col}`;

  return lookup.cellsById.get(cellId) ?? null;
}
```

- [ ] **Step 3: Store grid lookup metadata in `gridStore`**

Modify `src/features/grid/gridStore.ts`:

```typescript
import type { GridCell, GridSummary } from '@/shared/types/grid';
import type { MetricTransform } from '@/shared/geo/crs';

type GridOrigin = {
  metricOrigin: [number, number];
  metricCellSize: number;
  metricTransform: MetricTransform | null;
};

type GridState = {
  cellSize: number;
  summary: GridSummary | null;
  cells: GridCell[];
  origin: GridOrigin | null;
  setCellSize: (cellSize: number) => void;
  setSummary: (summary: GridSummary | null) => void;
  setPreview: (cells: GridCell[], summary: GridSummary | null, origin?: GridOrigin | null) => void;
  reset: () => void;
};

const INITIAL_STATE = {
  cellSize: 10,
  summary: null as GridSummary | null,
  cells: [] as GridCell[],
  origin: null as GridOrigin | null,
};

export const useGridStore = create<GridState>((set) => ({
  ...INITIAL_STATE,
  setCellSize: (cellSize) => set({ cellSize }),
  setSummary: (summary) => set({ summary }),
  setPreview: (cells, summary, origin) => set({ cells, summary, origin: origin ?? null }),
  reset: () => set(INITIAL_STATE),
}));
```

Key change: **removed `[...cells]` spread** — the cells array is built fresh by `buildGridPreview` each time, so spreading is unnecessary. Also added `origin` field.

- [ ] **Step 4: Pass grid origin metadata from useMap to gridStore**

In `useMap.ts`, modify the `renderGridPreview` function (line 587-599) to pass the origin:

```typescript
const renderGridPreview = (cells: GridCell[], summary: ReturnType<typeof buildGridPreview>['summary'] | null, preview: ReturnType<typeof buildGridPreview>) => {
  source.clear();
  setPreview(cells, summary, {
    metricOrigin: preview.metricOrigin,
    metricCellSize: preview.metricCellSize,
    metricTransform: metadata?.metricTransform ?? null,
  });

  for (const cell of cells) {
    source.addFeature(
      new Feature({
        geometry: new Polygon(cell.polygon),
        gridCell: cell,
      }),
    );
  }
};
```

Update all `renderGridPreview` call sites to pass the preview result object.

- [ ] **Step 5: Replace `findGridCellAtCoordinate` with `findCellAtCoordinate`**

In `useMap.ts`:
- Import `buildGridLookup`, `findCellAtCoordinate` from `@/shared/geo/gridLookup`
- Add a `gridLookupRef = useRef<GridLookupIndex | null>(null)`
- When gridCells change (in the ref sync useEffect or in renderGridPreview), rebuild the lookup
- In the pointermove handler, replace `findGridCellAtCoordinate(coordinate, currentGridCells)` with `findCellAtCoordinate(coordinate, gridLookupRef.current)`
- Remove the old `findGridCellAtCoordinate` function

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit`
Expected: No type errors

Test with a large grid (500+ cells), hover over map. Hover card should update smoothly with no lag.

---

### Task 5: Cache Grid Layer Styles

**Impact:** HIGH — eliminates repeated Style/Stroke/Fill object creation per feature per render.

**Files:**
- Modify: `src/features/map/useMap.ts:316-334`

- [ ] **Step 1: Add style cache in useMap**

At the top of `useMap` hook, add:

```typescript
const gridStyleCacheRef = useRef<Map<string, Style>>(new Map());
const gridStyleCacheKeyRef = useRef<string>('');
```

- [ ] **Step 2: Replace the inline style function with cached version**

Replace the grid layer style function (lines 316-334) with:

```typescript
style: (feature) => {
  const cell = feature.get('gridCell') as GridCell | undefined;
  if (!cell) {
    return new Style({
      stroke: new Stroke({ color: 'rgba(0, 0, 0, 0)', width: 1 }),
      fill: new Fill({ color: 'rgba(0, 0, 0, 0)' }),
    });
  }

  const outputValue = cell.aggregation?.outputValue;
  const cacheKey = `${cell.id}-${outputValue ?? 'na'}`;
  const cached = gridStyleCacheRef.current.get(cacheKey);
  if (cached) return cached;

  const colors = getGridCellStyleColors(cell, visibleClassificationLayerRef.current);
  const style = new Style({
    stroke: new Stroke({ color: colors.strokeColor, width: 1 }),
    fill: new Fill({ color: colors.fillColor }),
  });
  gridStyleCacheRef.current.set(cacheKey, style);
  return style;
},
```

- [ ] **Step 3: Invalidate style cache when classification changes**

In the existing `useEffect` that calls `gridLayerRef.current?.changed()` (line 557-559), add cache invalidation:

```typescript
useEffect(() => {
  gridStyleCacheRef.current.clear();
  gridLayerRef.current?.changed();
}, [classificationLayers, gridCells, visibleClassificationLayerId]);
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit`
Expected: No type errors

Test: Open map with grid, change classification colors. Grid colors should update correctly. Performance should improve on pan/zoom.

---

### Task 6: Move Raster Recoloring and Grid Aggregation off the Main Thread

**Impact:** HIGH — prevents main-thread stalls when recoloring single-band previews or aggregating dense fence windows.

**Files:**
- Create: `src/shared/workers/rasterCompute.worker.ts`
- Modify: `src/shared/types/raster.ts`
- Modify: `src/shared/geo/raster.ts`
- Modify: `src/shared/geo/geotiffExport.ts`
- Modify: `src/features/map/useMap.ts`

- [ ] **Step 1: Define worker message contracts**

In `src/shared/types/raster.ts`, add request/response types for:
- preview recolor
- grid aggregation

Example:

```typescript
export type RasterWorkerRequest =
  | {
      id: string;
      type: 'recolor-preview';
      payload: {
        width: number;
        height: number;
        sampleData: Float32Array;
        noDataValue: number | null;
        layer: RasterClassificationLayer;
      };
    }
  | {
      id: string;
      type: 'aggregate-grid';
      payload: {
        fenceRings: FenceRings;
        width: number;
        height: number;
        origin: RasterOrigin;
        resolution: RasterResolution;
        band: Float32Array;
        metricTransform: MetricTransform | null;
        gridCellWidth: number;
        gridCellHeight: number;
      };
    };
```

- [ ] **Step 2: Create a worker that only runs pure compute**

Create `src/shared/workers/rasterCompute.worker.ts` and move pure compute calls there:
- `buildRasterClassificationPreviewRgba`
- `buildGridAggregationFromFenceWindow`

The worker should return transferable data where possible:
- `Uint8ClampedArray.buffer`
- `Float32Array.buffer`

- [ ] **Step 3: Keep decoding on the main thread, move post-decode heavy compute to the worker**

Do **not** try to deserialize the whole GeoTIFF inside the worker in the first iteration. That will complicate bundling and duplicate session logic.

Instead:
- main thread reads raster session/window once
- worker receives the already extracted typed arrays and metadata
- worker returns recolored preview RGBA or aggregated cell data

- [ ] **Step 4: Add request cancellation / latest-wins semantics**

In `src/features/map/useMap.ts`, track a monotonically increasing request id for:
- styled preview regeneration
- grid aggregation preview generation

Only apply worker responses whose `id` matches the latest pending request.

Pattern:

```typescript
const aggregationJobIdRef = useRef(0);

aggregationJobIdRef.current += 1;
const jobId = `${aggregationJobIdRef.current}`;
worker.postMessage({ id: jobId, type: 'aggregate-grid', payload });

if (response.id !== `${aggregationJobIdRef.current}`) {
  return;
}
```

- [ ] **Step 5: Verify worker offload**

Run: `npm run build`
Expected: Vite bundles the worker successfully

Manual check:
1. Load a large single-band TIFF
2. Switch visible classification layers repeatedly
3. Draw a large fence and change grid size
Expected: UI remains responsive while the worker computes and only the latest job result is applied

---

### Task 7: Memoize Grid Rule Match Counts in RightPanel

**Impact:** MEDIUM-HIGH — eliminates O(cells × rules) computation on every render.

**Files:**
- Modify: `src/app/layout/RightPanel.tsx:402-433, 682-693`

- [ ] **Step 1: Extract a `useGridRuleStats` hook**

At the top of `RightPanel.tsx` (or in a separate file), add:

```typescript
type RuleStat = {
  matchedCount: number;
  areaM2: number;
  totalAmount: number;
};

function useGridRuleStats(
  gridCells: GridCell[],
  rules: Array<{ min: number; max: number | null; applicationRate?: number | null }>,
  cellAreaM2: number,
): RuleStat[] {
  const { useMemo } = await_import_react; // use regular import
  return useMemo(() => {
    if (gridCells.length === 0) return [];

    return rules.map((rule) => {
      let matchedCount = 0;
      for (const cell of gridCells) {
        const val = cell.aggregation?.meanValue;
        if (val == null) continue;
        if (val >= rule.min && (rule.max === null || val <= rule.max)) {
          matchedCount++;
        }
      }
      return {
        matchedCount,
        areaM2: matchedCount * cellAreaM2,
        totalAmount: rule.applicationRate ? rule.applicationRate * matchedCount : 0,
      };
    });
  }, [gridCells, rules, cellAreaM2]);
}
```

Actually, since we can't use dynamic imports in a hook, just write it as a plain `useMemo` call directly in the component. Add this at the top of the RightPanel component render function:

```typescript
const ruleStats = useMemo(() => {
  if (!activeClassificationLayer || activeClassificationLayer.mode !== 'rules' || gridCells.length === 0) {
    return null;
  }
  const rules = activeClassificationLayer.rules;
  let totalMatchedCount = 0;
  let totalFertilizer = 0;
  const perRule: Array<{ matchedCount: number; areaM2: number; totalAmount: number }> = [];

  for (const rule of rules) {
    let matchedCount = 0;
    for (const cell of gridCells) {
      const val = cell.aggregation?.meanValue;
      if (val == null) continue;
      if (val >= rule.min && (rule.max === null || val <= rule.max)) {
        matchedCount++;
      }
    }
    const areaM2 = matchedCount * cellAreaM2;
    const totalAmount = rule.applicationRate ? rule.applicationRate * matchedCount : 0;
    totalMatchedCount += matchedCount;
    totalFertilizer += totalAmount;
    perRule.push({ matchedCount, areaM2, totalAmount });
  }

  return { perRule, totalArea: totalMatchedCount * cellAreaM2, totalFertilizer };
}, [activeClassificationLayer, gridCells, cellAreaM2]);
```

- [ ] **Step 2: Replace inline IIFE at line 402-433 with ruleStats**

Replace:
```typescript
{activeClassificationLayer?.mode === 'rules' && gridCells.length > 0 && (() => {
  // ... entire inline computation
})()}
```

With:
```typescript
{ruleStats && (
  <>
    <div className="metric-item" style={{ borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: '8px', marginTop: '4px' }}>
      <dt className="metric-label">分类覆盖面积</dt>
      <dd>{formatMetricNumber(ruleStats.totalArea)} m²</dd>
    </div>
    <div className="metric-item">
      <dt className="metric-label">预计总用药量</dt>
      <dd style={{ color: '#d35400', fontWeight: 600 }}>{formatMetricNumber(ruleStats.totalFertilizer)}</dd>
    </div>
  </>
)}
```

- [ ] **Step 3: Replace inline computation at line 682-693 with ruleStats**

Replace:
```typescript
let matchedCount = 0;
if (gridCells && gridCells.length > 0) {
  for (const cell of gridCells) { ... }
}
```

With:
```typescript
const matchedCount = ruleStats?.perRule[index]?.matchedCount ?? 0;
```

And similarly for `areaM2` and `totalAmount`:
```typescript
const areaM2 = ruleStats?.perRule[index]?.areaM2 ?? 0;
const totalAmount = ruleStats?.perRule[index]?.totalAmount ?? 0;
```

- [ ] **Step 4: Add `useMemo` import**

Ensure `useMemo` is imported from 'react' in RightPanel.tsx.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit`
Expected: No type errors

Test: Open RightPanel with grid data and classification rules. Values should display correctly.

---

### Task 8: Consolidate useEffect Ref Syncs with Zustand subscribe

**Impact:** MEDIUM — reduces 6 useEffects to a single subscription. Cleaner code, fewer effect runs.

**Files:**
- Modify: `src/features/map/useMap.ts:199-224`

- [ ] **Step 1: Replace 6 individual useEffects with a single useEffect using zustand subscribe**

Replace lines 199-224 with:

```typescript
useEffect(() => {
  const unsubRaster = useRasterStore.subscribe((state) => {
    metadataRef.current = state.metadata;
    previewRef.current = state.preview;
    validityMaskRef.current = state.validityMask;
  });
  const unsubFence = useFenceStore.subscribe((state) => {
    fenceRef.current = state.fence;
  });
  const unsubGrid = useGridStore.subscribe((state) => {
    gridCellsRef.current = state.cells;
  });
  const unsubMapUi = useMapUiStore.subscribe((state) => {
    visibleClassificationLayerRef.current = getVisibleClassificationLayer(
      state.classificationLayers,
      state.visibleClassificationLayerId,
    );
  });

  // Initialize refs with current state
  metadataRef.current = useRasterStore.getState().metadata;
  previewRef.current = useRasterStore.getState().preview;
  validityMaskRef.current = useRasterStore.getState().validityMask;
  fenceRef.current = useFenceStore.getState().fence;
  gridCellsRef.current = useGridStore.getState().cells;
  visibleClassificationLayerRef.current = getVisibleClassificationLayer(
    useMapUiStore.getState().classificationLayers,
    useMapUiStore.getState().visibleClassificationLayerId,
  );

  return () => {
    unsubRaster();
    unsubFence();
    unsubGrid();
    unsubMapUi();
  };
}, []);
```

This is more efficient because:
- zustand `subscribe` fires synchronously on state change (no React scheduling overhead)
- Single cleanup instead of 6
- No dependency array per-effect (each useEffect with deps causes React to diff deps on every render)

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: No type errors

Test: Move mouse over map, verify hover info still updates correctly.

---

### Task 9: Batch Feature Addition to VectorSource

**Impact:** MEDIUM — reduces N `addFeature` calls (each triggers a change event) to a single `addFeatures` call.

**Files:**
- Modify: `src/features/map/useMap.ts:587-599`

- [ ] **Step 1: Replace per-cell addFeature with batch addFeatures**

Replace the `renderGridPreview` function (lines 587-599):

```typescript
const renderGridPreview = (cells: GridCell[], summary: ReturnType<typeof buildGridPreview>['summary'] | null, preview: ReturnType<typeof buildGridPreview>) => {
  source.clear();
  setPreview(cells, summary, {
    metricOrigin: preview.metricOrigin,
    metricCellSize: preview.metricCellSize,
    metricTransform: metadata?.metricTransform ?? null,
  });

  const features = cells.map(
    (cell) =>
      new Feature({
        geometry: new Polygon(cell.polygon),
        gridCell: cell,
      }),
  );
  source.addFeatures(features);
};
```

Key change: `source.addFeatures(features)` (batch) instead of `source.addFeature(feature)` in a loop (N individual events → 1 batch event).

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: No type errors

Test: Draw fence, generate grid, verify grid appears correctly.

---

## Summary of Expected Improvements

| Optimization | Before | After | Impact |
|---|---|---|---|
| Baseline instrumentation + debug gating | No trustworthy baseline, logs always noisy | Stable measurement + opt-in debug output | De-risks rollout |
| RasterSession reuse | Re-read and re-decode the same source in multiple phases | One decode reused across metadata / preview / mask / window / export | Largest load-time and memory win |
| pointermove throttle | Every mouse event → full computation | At most 1 per rAF frame | 60-90% fewer computations |
| O(1) grid lookup | O(n) linear scan per mouse move | O(1) row/col computation | From ~5ms to ~0.01ms per lookup |
| Style caching | New Style+Stroke+Fill per feature per render | Cached by cell id + value | ~95% fewer object allocations |
| Workerized preview/grid compute | Main thread blocks during recolor/aggregation | Async compute with latest-wins cancellation | Major interaction smoothness win |
| RightPanel useMemo | O(cells × rules) per render | Cached until data changes | Eliminates redundant iteration |
| Consolidated ref syncs | 6 useEffects with deps | 1 zustand subscribe | Fewer effect cycles |
| Batch addFeatures | N addFeature calls (N change events) | 1 addFeatures call (1 event) | ~95% fewer VectorSource events |
| Remove cells spread | `[...cells]` copy on every setPreview | Direct assignment | Eliminates array copy |
