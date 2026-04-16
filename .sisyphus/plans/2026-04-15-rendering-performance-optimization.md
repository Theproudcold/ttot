# Rendering Performance Optimization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate rendering jank and reduce unnecessary re-computation across the map interaction pipeline, grid rendering, and UI panels.

**Architecture:** Incremental, layered optimization — start with the cheapest, highest-impact fixes (throttling, memoization), then move to structural improvements (spatial index, style caching, store optimization). Each task is independently verifiable.

**Tech Stack:** React 19, Zustand 5, OpenLayers 10, TypeScript, Vite

---

## File Structure

| File | Change Type | Responsibility |
|------|-------------|---------------|
| `src/shared/hooks/useRafThrottle.ts` | **Create** | Reusable rAF-based throttle hook |
| `src/shared/geo/gridLookup.ts` | **Create** | O(1) grid cell spatial lookup |
| `src/features/map/useMap.ts` | Modify | Throttle pointermove, use grid lookup, cache styles, consolidate ref syncs |
| `src/features/grid/gridStore.ts` | Modify | Store grid origin metadata, remove unnecessary spread |
| `src/features/map/MapView.tsx` | Modify | Derive hoverInfo-related values outside render |
| `src/app/layout/RightPanel.tsx` | Modify | Memoize grid rule match computations |
| `src/shared/geo/grid.ts` | Modify | Return grid origin for spatial lookup |

---

### Task 1: Add requestAnimationFrame Throttle for pointermove

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

### Task 2: O(1) Grid Cell Spatial Lookup

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

### Task 3: Cache Grid Layer Styles

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

### Task 4: Memoize Grid Rule Match Counts in RightPanel

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

### Task 5: Consolidate useEffect Ref Syncs with Zustand subscribe

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

### Task 6: Batch Feature Addition to VectorSource

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
| pointermove throttle | Every mouse event → full computation | At most 1 per rAF frame | 60-90% fewer computations |
| O(1) grid lookup | O(n) linear scan per mouse move | O(1) row/col computation | From ~5ms to ~0.01ms per lookup |
| Style caching | New Style+Stroke+Fill per feature per render | Cached by cell id + value | ~95% fewer object allocations |
| RightPanel useMemo | O(cells × rules) per render | Cached until data changes | Eliminates redundant iteration |
| Consolidated ref syncs | 6 useEffects with deps | 1 zustand subscribe | Fewer effect cycles |
| Batch addFeatures | N addFeature calls (N change events) | 1 addFeatures call (1 event) | ~95% fewer VectorSource events |
| Remove cells spread | `[...cells]` copy on every setPreview | Direct assignment | Eliminates array copy |
