import type { MetricTransform } from '@/shared/geo/crs';
import { getFenceSummary, isPointInFence } from '@/shared/geo/fence';
import type { FencePosition, FenceRings } from '@/shared/types/fence';
import type { GridAggregationResult, GridCellAggregation } from '@/shared/types/grid';
import type { RasterOrigin, RasterResolution } from '@/shared/types/raster';

type SupportedRasterArray =
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Float32Array
  | Float64Array;

type PixelWindow = [number, number, number, number];

function assertValidGridCellSize(gridCellWidth: number, gridCellHeight: number): void {
  if (!Number.isFinite(gridCellWidth) || gridCellWidth <= 0 || !Number.isFinite(gridCellHeight) || gridCellHeight <= 0) {
    throw new Error('cell size must be greater than 0');
  }
}

function getPixelCenter(
  col: number,
  row: number,
  origin: RasterOrigin,
  resolution: RasterResolution,
): FencePosition {
  const [originX, originY] = origin;
  const [resolutionX, resolutionY] = resolution;

  return [originX + (col + 0.5) * resolutionX, originY + (row + 0.5) * resolutionY];
}

function buildCellAggregation(cellId: string, row: number, col: number): GridCellAggregation {
  return {
    cellId,
    row,
    col,
    pixelCount: 0,
    validPixelCount: 0,
    sumValue: 0,
    meanValue: null,
    outputValue: null,
  };
}

function createIdentityMetricTransform(fenceRings: FenceRings): MetricTransform {
  const { bbox } = getFenceSummary(fenceRings);
  const [minX, minY, maxX, maxY] = bbox;

  return {
    coordinateDisplayMode: 'projected',
    metricExtent: {
      minX,
      minY,
      maxX,
      maxY,
    },
    metricWidth: Math.max(0, maxX - minX),
    metricHeight: Math.max(0, maxY - minY),
    toMetric: ([x, y]) => [x, y],
    fromMetric: ([x, y]) => [x, y],
  };
}

function resolveMetricTransform(fenceRings: FenceRings, metricTransform?: MetricTransform): MetricTransform {
  return metricTransform ?? createIdentityMetricTransform(fenceRings);
}

function getMetricBounds(fenceRings: FenceRings, metricTransform: MetricTransform): [number, number, number, number] {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const ring of fenceRings) {
    for (const point of ring) {
      const [x, y] = metricTransform.toMetric(point);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  return [minX, minY, maxX, maxY];
}

function getGridMetrics(
  fenceRings: FenceRings,
  gridCellWidth: number,
  gridCellHeight: number,
  metricTransform: MetricTransform,
) {
  assertValidGridCellSize(gridCellWidth, gridCellHeight);
  const [gridMinX, gridMinY, gridMaxX, gridMaxY] = getMetricBounds(fenceRings, metricTransform);

  return {
    gridMinX,
    gridMinY,
    gridMaxX,
    gridMaxY,
    cols: Math.ceil((gridMaxX - gridMinX) / gridCellWidth),
    rows: Math.ceil((gridMaxY - gridMinY) / gridCellHeight),
  };
}

function getCellBounds(input: {
  row: number;
  col: number;
  gridMinX: number;
  gridMinY: number;
  gridMaxX: number;
  gridMaxY: number;
  gridCellWidth: number;
  gridCellHeight: number;
}): { minX: number; minY: number; maxX: number; maxY: number } {
  const { row, col, gridMinX, gridMinY, gridMaxX, gridMaxY, gridCellWidth, gridCellHeight } = input;
  const minX = gridMinX + col * gridCellWidth;
  const maxX = Math.min(minX + gridCellWidth, gridMaxX);
  const minY = gridMinY + row * gridCellHeight;
  const maxY = Math.min(minY + gridCellHeight, gridMaxY);

  return { minX, minY, maxX, maxY };
}

function buildIncludedCellIds(
  fenceRings: FenceRings,
  gridCellWidth: number,
  gridCellHeight: number,
  metricTransform: MetricTransform,
): {
  includedCellIds: Set<string>;
  gridMinX: number;
  gridMinY: number;
  gridMaxX: number;
  gridMaxY: number;
  cols: number;
  rows: number;
} {
  const metrics = getGridMetrics(fenceRings, gridCellWidth, gridCellHeight, metricTransform);
  const includedCellIds = new Set<string>();

  for (let row = 0; row < metrics.rows; row += 1) {
    for (let col = 0; col < metrics.cols; col += 1) {
      const { minX, minY, maxX, maxY } = getCellBounds({
        row,
        col,
        gridMinX: metrics.gridMinX,
        gridMinY: metrics.gridMinY,
        gridMaxX: metrics.gridMaxX,
        gridMaxY: metrics.gridMaxY,
        gridCellWidth,
        gridCellHeight,
      });
      const center = metricTransform.fromMetric([(minX + maxX) / 2, (minY + maxY) / 2]);

      if (isPointInFence(center, fenceRings)) {
        includedCellIds.add(`r${row}-c${col}`);
      }
    }
  }

  return {
    includedCellIds,
    ...metrics,
  };
}

function getCellIdForPixel(input: {
  center: FencePosition;
  gridMinX: number;
  gridMinY: number;
  cols: number;
  rows: number;
  gridCellWidth: number;
  gridCellHeight: number;
  includedCellIds: Set<string>;
}): { cellId: string; row: number; col: number } | null {
  const { center, gridMinX, gridMinY, cols, rows, gridCellWidth, gridCellHeight, includedCellIds } = input;
  const [centerX, centerY] = center;
  const col = Math.floor((centerX - gridMinX) / gridCellWidth);
  const row = Math.floor((centerY - gridMinY) / gridCellHeight);

  if (col < 0 || col >= cols || row < 0 || row >= rows) {
    return null;
  }

  const cellId = `r${row}-c${col}`;
  if (!includedCellIds.has(cellId)) {
    return null;
  }

  return { cellId, row, col };
}

function finalizeAggregation(cellsById: Record<string, GridCellAggregation>): GridAggregationResult {
  for (const cell of Object.values(cellsById)) {
    if (cell.validPixelCount === 0) {
      cell.meanValue = null;
      cell.outputValue = null;
      continue;
    }

    cell.meanValue = cell.sumValue / cell.validPixelCount;
    cell.outputValue = cell.meanValue;
  }

  return { cellsById };
}

export function aggregateGridCellsFromRasterWindow(input: {
  window: PixelWindow;
  width: number;
  height: number;
  origin: RasterOrigin;
  resolution: RasterResolution;
  fenceRings: FenceRings;
  gridCellWidth: number;
  gridCellHeight: number;
  band: SupportedRasterArray;
  noDataValue: number | null;
  metricTransform?: MetricTransform;
}): GridAggregationResult {
  const {
    window,
    width,
    height,
    origin,
    resolution,
    fenceRings,
    gridCellWidth,
    gridCellHeight,
    band,
    noDataValue,
    metricTransform,
  } =
    input;
  assertValidGridCellSize(gridCellWidth, gridCellHeight);
  const resolvedMetricTransform = resolveMetricTransform(fenceRings, metricTransform);
  const [windowStartCol, windowStartRow] = window;
  const { includedCellIds, gridMinX, gridMinY, cols, rows } = buildIncludedCellIds(
    fenceRings,
    gridCellWidth,
    gridCellHeight,
    resolvedMetricTransform,
  );
  const cellsById: Record<string, GridCellAggregation> = {};

  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const pixelIndex = row * width + col;
      const center = resolvedMetricTransform.toMetric(
        getPixelCenter(windowStartCol + col, windowStartRow + row, origin, resolution),
      );
      const cellMatch = getCellIdForPixel({
        center,
        gridMinX,
        gridMinY,
        cols,
        rows,
        gridCellWidth,
        gridCellHeight,
        includedCellIds,
      });

      if (!cellMatch) {
        continue;
      }

      const cell =
        cellsById[cellMatch.cellId] ??
        (cellsById[cellMatch.cellId] = buildCellAggregation(
          cellMatch.cellId,
          cellMatch.row,
          cellMatch.col,
        ));
      cell.pixelCount += 1;

      const value = band[pixelIndex];
      if ((noDataValue !== null && value === noDataValue) || !Number.isFinite(value)) {
        continue;
      }

      cell.validPixelCount += 1;
      cell.sumValue += value;
    }
  }

  return finalizeAggregation(cellsById);
}

export function applyGridAggregationToBands(input: {
  bands: SupportedRasterArray[];
  aggregation: GridAggregationResult;
  width: number;
  height: number;
  window: PixelWindow;
  origin: RasterOrigin;
  resolution: RasterResolution;
  fenceRings: FenceRings;
  gridCellWidth: number;
  gridCellHeight: number;
  noDataValue: number;
  metricTransform?: MetricTransform;
}): { bands: Float64Array[]; maskedPixelCount: number } {
  const {
    bands,
    aggregation,
    width,
    height,
    window,
    origin,
    resolution,
    fenceRings,
    gridCellWidth,
    gridCellHeight,
    noDataValue,
    metricTransform,
  } = input;
  assertValidGridCellSize(gridCellWidth, gridCellHeight);
  const resolvedMetricTransform = resolveMetricTransform(fenceRings, metricTransform);
  const [windowStartCol, windowStartRow] = window;
  const { includedCellIds, gridMinX, gridMinY, cols, rows } = buildIncludedCellIds(
    fenceRings,
    gridCellWidth,
    gridCellHeight,
    resolvedMetricTransform,
  );

  const rewrittenBands = bands.map((band) => {
    const nextBand = new Float64Array(band.length);

    for (let row = 0; row < height; row += 1) {
      for (let col = 0; col < width; col += 1) {
        const pixelIndex = row * width + col;
        const center = resolvedMetricTransform.toMetric(
          getPixelCenter(windowStartCol + col, windowStartRow + row, origin, resolution),
        );
        const cellMatch = getCellIdForPixel({
          center,
          gridMinX,
          gridMinY,
          cols,
          rows,
          gridCellWidth,
          gridCellHeight,
          includedCellIds,
        });
        const outputValue = cellMatch
          ? aggregation.cellsById[cellMatch.cellId]?.outputValue ?? null
          : null;

        nextBand[pixelIndex] = outputValue === null ? noDataValue : outputValue;
      }
    }

    return nextBand;
  });

  let maskedPixelCount = 0;
  const sourceBand = bands[0];
  const rewrittenPrimaryBand = rewrittenBands[0];

  if (sourceBand && rewrittenPrimaryBand) {
    for (let pixelIndex = 0; pixelIndex < rewrittenPrimaryBand.length; pixelIndex += 1) {
      if (
        rewrittenPrimaryBand[pixelIndex] === noDataValue &&
        sourceBand[pixelIndex] !== noDataValue
      ) {
        maskedPixelCount += 1;
      }
    }
  }

  return {
    bands: rewrittenBands,
    maskedPixelCount,
  };
}
