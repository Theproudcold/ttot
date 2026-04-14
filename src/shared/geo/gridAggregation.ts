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

function assertValidGridCellSize(gridCellSize: number): void {
  if (!Number.isFinite(gridCellSize) || gridCellSize <= 0) {
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

function getGridMetrics(fenceRings: FenceRings, gridCellSize: number) {
  assertValidGridCellSize(gridCellSize);
  const { bbox } = getFenceSummary(fenceRings);
  const [gridMinX, gridMinY, gridMaxX, gridMaxY] = bbox;

  return {
    gridMinX,
    gridMinY,
    gridMaxX,
    gridMaxY,
    cols: Math.ceil((gridMaxX - gridMinX) / gridCellSize),
    rows: Math.ceil((gridMaxY - gridMinY) / gridCellSize),
  };
}

function getCellBounds(input: {
  row: number;
  col: number;
  gridMinX: number;
  gridMinY: number;
  gridMaxX: number;
  gridMaxY: number;
  gridCellSize: number;
}): { minX: number; minY: number; maxX: number; maxY: number } {
  const { row, col, gridMinX, gridMinY, gridMaxX, gridMaxY, gridCellSize } = input;
  const minX = gridMinX + col * gridCellSize;
  const maxX = Math.min(minX + gridCellSize, gridMaxX);
  const minY = gridMinY + row * gridCellSize;
  const maxY = Math.min(minY + gridCellSize, gridMaxY);

  return { minX, minY, maxX, maxY };
}

function buildIncludedCellIds(
  fenceRings: FenceRings,
  gridCellSize: number,
): {
  includedCellIds: Set<string>;
  gridMinX: number;
  gridMinY: number;
  gridMaxX: number;
  gridMaxY: number;
  cols: number;
  rows: number;
} {
  const metrics = getGridMetrics(fenceRings, gridCellSize);
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
        gridCellSize,
      });
      const center: FencePosition = [(minX + maxX) / 2, (minY + maxY) / 2];

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
  gridCellSize: number;
  includedCellIds: Set<string>;
}): { cellId: string; row: number; col: number } | null {
  const { center, gridMinX, gridMinY, cols, rows, gridCellSize, includedCellIds } = input;
  const [centerX, centerY] = center;
  const col = Math.floor((centerX - gridMinX) / gridCellSize);
  const row = Math.floor((centerY - gridMinY) / gridCellSize);

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
  gridCellSize: number;
  band: SupportedRasterArray;
  noDataValue: number | null;
}): GridAggregationResult {
  const { window, width, height, origin, resolution, fenceRings, gridCellSize, band, noDataValue } =
    input;
  assertValidGridCellSize(gridCellSize);
  const [windowStartCol, windowStartRow] = window;
  const { includedCellIds, gridMinX, gridMinY, cols, rows } = buildIncludedCellIds(
    fenceRings,
    gridCellSize,
  );
  const cellsById: Record<string, GridCellAggregation> = {};

  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const pixelIndex = row * width + col;
      const center = getPixelCenter(windowStartCol + col, windowStartRow + row, origin, resolution);
      const cellMatch = getCellIdForPixel({
        center,
        gridMinX,
        gridMinY,
        cols,
        rows,
        gridCellSize,
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
  gridCellSize: number;
  noDataValue: number;
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
    gridCellSize,
    noDataValue,
  } = input;
  assertValidGridCellSize(gridCellSize);
  const [windowStartCol, windowStartRow] = window;
  const { includedCellIds, gridMinX, gridMinY, cols, rows } = buildIncludedCellIds(
    fenceRings,
    gridCellSize,
  );

  const rewrittenBands = bands.map((band) => {
    const nextBand = new Float64Array(band.length);

    for (let row = 0; row < height; row += 1) {
      for (let col = 0; col < width; col += 1) {
        const pixelIndex = row * width + col;
        const center = getPixelCenter(windowStartCol + col, windowStartRow + row, origin, resolution);
        const cellMatch = getCellIdForPixel({
          center,
          gridMinX,
          gridMinY,
          cols,
          rows,
          gridCellSize,
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
