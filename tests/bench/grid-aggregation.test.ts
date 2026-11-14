/**
 * 网格聚合护栏。
 *
 * 这里保留一份刻意的"旧写法"对照实现（逐像元度量调用 + 字符串键 Set/对象），
 * 用来验证优化后的内核（列区间扫描 + 类型化累加器）在随机参数下逐单元格完全等价，
 * 同时在结尾输出一次耗时对比，便于回归时观察数量级。
 *
 * 对照实现只用于测试，不参与生产代码路径。
 */
import { describe, expect, it } from 'vitest';

import { createMetricTransform } from '@/shared/geo/crs';
import type { MetricTransform } from '@/shared/geo/crs';
import { getFenceSummary, isPointInFence } from '@/shared/geo/fence';
import {
  aggregateGridCellsFromRasterWindow,
  aggregateGridCellsFromRasterWindowAsync,
  applyGridAggregationToBands,
} from '@/shared/geo/gridAggregation';
import type { FencePosition, FenceRings } from '@/shared/types/fence';
import type { GridAggregationMode, GridAggregationResult, GridCellAggregation } from '@/shared/types/grid';
import type { RasterOrigin, RasterResolution } from '@/shared/types/raster';

const identityTransform: MetricTransform = {
  coordinateDisplayMode: 'projected',
  metricExtent: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
  metricWidth: 0,
  metricHeight: 0,
  toMetric: ([x, y]) => [x, y],
  fromMetric: ([x, y]) => [x, y],
};

type AggregationCase = {
  name: string;
  width: number;
  height: number;
  window: [number, number, number, number];
  origin: RasterOrigin;
  resolution: RasterResolution;
  fenceRings: FenceRings;
  gridCellWidth: number;
  gridCellHeight: number;
  band: Float32Array | Uint16Array;
  noDataValue: number | null;
  rotationDeg: number;
  aggregationMode: GridAggregationMode;
  metricTransform?: MetricTransform;
};

/* ------------------------------------------------------------------ */
/* 对照实现（旧写法）                                                   */
/* ------------------------------------------------------------------ */

function rotatePoint(point: [number, number], center: [number, number], angleRad: number): [number, number] {
  if (angleRad === 0) {
    return point;
  }

  const [x, y] = point;
  const [cx, cy] = center;
  const dx = x - cx;
  const dy = y - cy;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);

  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

function metricBounds(fenceRings: FenceRings, transform: MetricTransform): [number, number, number, number] {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const ring of fenceRings) {
    for (const point of ring) {
      const [x, y] = transform.toMetric(point);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  return [minX, minY, maxX, maxY];
}

function pixelCenter(
  col: number,
  row: number,
  origin: RasterOrigin,
  resolution: RasterResolution,
): FencePosition {
  const [originX, originY] = origin;
  const [resolutionX, resolutionY] = resolution;

  return [originX + (col + 0.5) * resolutionX, originY + (row + 0.5) * resolutionY];
}

export function referenceAggregate(input: AggregationCase): GridAggregationResult {
  const {
    width,
    height,
    window,
    origin,
    resolution,
    fenceRings,
    gridCellWidth,
    gridCellHeight,
    band,
    noDataValue,
    rotationDeg,
    aggregationMode,
    metricTransform,
  } = input;
  const transform = metricTransform ?? identityTransform;
  const [windowStartCol, windowStartRow] = window;
  const [minX, minY, maxX, maxY] = metricBounds(fenceRings, transform);
  const rotationRad = (rotationDeg * Math.PI) / 180;

  let gridMinX = minX;
  let gridMinY = minY;
  let gridMaxX = maxX;
  let gridMaxY = maxY;

  if (rotationRad !== 0) {
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    let rotatedMinX = Number.POSITIVE_INFINITY;
    let rotatedMinY = Number.POSITIVE_INFINITY;
    let rotatedMaxX = Number.NEGATIVE_INFINITY;
    let rotatedMaxY = Number.NEGATIVE_INFINITY;

    for (const ring of fenceRings) {
      for (const point of ring) {
        const [metricX, metricY] = transform.toMetric(point);
        const [rotatedX, rotatedY] = rotatePoint([metricX, metricY], [centerX, centerY], -rotationRad);
        rotatedMinX = Math.min(rotatedMinX, rotatedX);
        rotatedMinY = Math.min(rotatedMinY, rotatedY);
        rotatedMaxX = Math.max(rotatedMaxX, rotatedX);
        rotatedMaxY = Math.max(rotatedMaxY, rotatedY);
      }
    }

    gridMinX = rotatedMinX;
    gridMinY = rotatedMinY;
    gridMaxX = rotatedMaxX;
    gridMaxY = rotatedMaxY;
  }

  const cols = Math.ceil((gridMaxX - gridMinX) / gridCellWidth);
  const rows = Math.ceil((gridMaxY - gridMinY) / gridCellHeight);
  const gridCenter: [number, number] = [(minX + maxX) / 2, (minY + maxY) / 2];
  const includedCellIds = new Set<string>();

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const cellMinX = gridMinX + col * gridCellWidth;
      const cellMaxX = Math.min(cellMinX + gridCellWidth, gridMaxX);
      const cellMinY = gridMinY + row * gridCellHeight;
      const cellMaxY = Math.min(cellMinY + gridCellHeight, gridMaxY);
      let center: [number, number] = [(cellMinX + cellMaxX) / 2, (cellMinY + cellMaxY) / 2];

      if (rotationRad !== 0) {
        center = rotatePoint(center, gridCenter, rotationRad);
      }

      if (isPointInFence(transform.fromMetric(center), fenceRings)) {
        includedCellIds.add(`r${row}-c${col}`);
      }
    }
  }

  const cellsById: Record<string, GridCellAggregation> = {};

  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const pixelIndex = row * width + col;
      let center = transform.toMetric(
        pixelCenter(windowStartCol + col, windowStartRow + row, origin, resolution),
      );

      if (rotationRad !== 0) {
        center = rotatePoint(center, gridCenter, -rotationRad);
      }

      const cellCol = Math.floor((center[0] - gridMinX) / gridCellWidth);
      const cellRow = Math.floor((center[1] - gridMinY) / gridCellHeight);

      if (cellCol < 0 || cellCol >= cols || cellRow < 0 || cellRow >= rows) {
        continue;
      }

      const cellId = `r${cellRow}-c${cellCol}`;
      if (!includedCellIds.has(cellId)) {
        continue;
      }

      const cell =
        cellsById[cellId] ??
        (cellsById[cellId] = {
          cellId,
          row: cellRow,
          col: cellCol,
          pixelCount: 0,
          validPixelCount: 0,
          sumValue: 0,
          meanValue: null,
          minValue: Number.POSITIVE_INFINITY,
          maxValue: Number.NEGATIVE_INFINITY,
          outputValue: null,
        });

      cell.pixelCount += 1;
      const value = band[pixelIndex];

      if ((noDataValue !== null && value === noDataValue) || !Number.isFinite(value)) {
        continue;
      }

      cell.validPixelCount += 1;
      cell.sumValue += value;
      cell.minValue = Math.min(cell.minValue ?? Number.POSITIVE_INFINITY, value);
      cell.maxValue = Math.max(cell.maxValue ?? Number.NEGATIVE_INFINITY, value);
    }
  }

  for (const cell of Object.values(cellsById)) {
    if (cell.validPixelCount === 0) {
      cell.meanValue = null;
      cell.minValue = null;
      cell.maxValue = null;
      cell.outputValue = null;
      continue;
    }

    cell.meanValue = cell.sumValue / cell.validPixelCount;

    if (aggregationMode === 'max') {
      cell.outputValue = cell.maxValue;
    } else if (aggregationMode === 'min') {
      cell.outputValue = cell.minValue;
    } else {
      cell.outputValue = cell.meanValue;
    }
  }

  return { cellsById };
}

function referenceApplyBands(input: AggregationCase & { aggregation: GridAggregationResult; bands: Array<Float32Array | Uint16Array> }) {
  const { width, height, window, origin, resolution, fenceRings, gridCellWidth, gridCellHeight, rotationDeg, metricTransform, aggregation, bands } = input;
  const noDataValue = -9999;
  const reference = referenceAggregate({ ...input, band: bands[0], noDataValue });
  const transform = metricTransform ?? identityTransform;
  const [windowStartCol, windowStartRow] = window;
  const [minX, minY, maxX, maxY] = metricBounds(fenceRings, transform);
  const rotationRad = (rotationDeg * Math.PI) / 180;
  let gridMinX = minX;
  let gridMinY = minY;
  let gridMaxX = maxX;
  let gridMaxY = maxY;

  if (rotationRad !== 0) {
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    let rotatedMinX = Number.POSITIVE_INFINITY;
    let rotatedMinY = Number.POSITIVE_INFINITY;
    let rotatedMaxX = Number.NEGATIVE_INFINITY;
    let rotatedMaxY = Number.NEGATIVE_INFINITY;

    for (const ring of fenceRings) {
      for (const point of ring) {
        const [metricX, metricY] = transform.toMetric(point);
        const [rotatedX, rotatedY] = rotatePoint([metricX, metricY], [centerX, centerY], -rotationRad);
        rotatedMinX = Math.min(rotatedMinX, rotatedX);
        rotatedMinY = Math.min(rotatedMinY, rotatedY);
        rotatedMaxX = Math.max(rotatedMaxX, rotatedX);
        rotatedMaxY = Math.max(rotatedMaxY, rotatedY);
      }
    }

    gridMinX = rotatedMinX;
    gridMinY = rotatedMinY;
    gridMaxX = rotatedMaxX;
    gridMaxY = rotatedMaxY;
  }

  const cols = Math.ceil((gridMaxX - gridMinX) / gridCellWidth);
  const rows = Math.ceil((gridMaxY - gridMinY) / gridCellHeight);
  const gridCenter: [number, number] = [(minX + maxX) / 2, (minY + maxY) / 2];

  return bands.map((band) => {
    const next = new Float64Array(band.length);

    for (let row = 0; row < height; row += 1) {
      for (let col = 0; col < width; col += 1) {
        const pixelIndex = row * width + col;
        let center = transform.toMetric(pixelCenter(windowStartCol + col, windowStartRow + row, origin, resolution));

        if (rotationRad !== 0) {
          center = rotatePoint(center, gridCenter, -rotationRad);
        }

        const cellCol = Math.floor((center[0] - gridMinX) / gridCellWidth);
        const cellRow = Math.floor((center[1] - gridMinY) / gridCellHeight);
        let outputValue: number | null = null;

        if (cellCol >= 0 && cellCol < cols && cellRow >= 0 && cellRow < rows) {
          const cell = aggregation.cellsById[`r${cellRow}-c${cellCol}`];
          outputValue = cell ? cell.outputValue : null;
        }

        next[pixelIndex] = outputValue === null ? noDataValue : outputValue;
      }
    }

    void reference;
    return next;
  });
}

/* ------------------------------------------------------------------ */
/* 随机用例生成                                                         */
/* ------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let state = seed;

  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, values: T[]): T {
  return values[Math.floor(rand() * values.length) % values.length];
}

function rectangleRing(x0: number, y0: number, x1: number, y1: number): FenceRings[number] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ];
}

function buildFence(rand: () => number, geoMinX: number, geoMinY: number, geoMaxX: number, geoMaxY: number): FenceRings {
  const insetX = (geoMaxX - geoMinX) * (0.05 + rand() * 0.2);
  const insetY = (geoMaxY - geoMinY) * (0.05 + rand() * 0.2);
  const x0 = geoMinX + insetX;
  const x1 = geoMaxX - insetX;
  const y0 = geoMinY + insetY;
  const y1 = geoMaxY - insetY;
  const shape = rand();
  let outer: FenceRings[number];

  if (shape < 0.45) {
    outer = rectangleRing(x0, y0, x1, y1);
  } else if (shape < 0.7) {
    const midX = (x0 + x1) / 2;
    outer = [
      [x0, y0],
      [x1, y0],
      [x1, (y0 + y1) / 2],
      [midX, (y0 + y1) / 2],
      [midX, y1],
      [x0, y1],
      [x0, y0],
    ];
  } else {
    outer = [
      [x0, y0],
      [x1, y0],
      [(x0 + x1) / 2, y1],
      [x0, y0],
    ];
  }

  const rings: FenceRings = [outer];

  if (rand() < 0.35) {
    const holeX0 = x0 + (x1 - x0) * 0.3;
    const holeX1 = x0 + (x1 - x0) * 0.6;
    const holeY0 = y0 + (y1 - y0) * 0.3;
    const holeY1 = y0 + (y1 - y0) * 0.6;
    if (holeX1 > holeX0 && holeY1 > holeY0) {
      rings.push(rectangleRing(holeX0, holeY0, holeX1, holeY1));
    }
  }

  return rings;
}

function buildCase(rand: () => number, index: number): AggregationCase {
  const fullWidth = 30 + Math.floor(rand() * 40);
  const fullHeight = 24 + Math.floor(rand() * 34);
  const windowWidth = 1 + Math.floor(rand() * fullWidth);
  const windowHeight = 1 + Math.floor(rand() * fullHeight);
  const startCol = Math.floor(rand() * (fullWidth - windowWidth + 1));
  const startRow = Math.floor(rand() * (fullHeight - windowHeight + 1));
  const geographic = rand() < 0.35;
  const resolutionX = geographic ? 0.00045 : pick(rand, [1, 1.5, 2, 0.5, -1]);
  const resolutionY = geographic ? -0.0003 : pick(rand, [-1, -1.5, -2, -0.5, 1]);
  const origin: RasterOrigin = geographic ? [119.42, 36.51] : [100 + rand() * 10, 200 + rand() * 10];

  const edgeCol = origin[0] + startCol * resolutionX;
  const farCol = origin[0] + (startCol + windowWidth) * resolutionX;
  const edgeRow = origin[1] + startRow * resolutionY;
  const farRow = origin[1] + (startRow + windowHeight) * resolutionY;
  const fenceRings = buildFence(
    rand,
    Math.min(edgeCol, farCol),
    Math.min(edgeRow, farRow),
    Math.max(edgeCol, farCol),
    Math.max(edgeRow, farRow),
  );

  const band = new Float32Array(windowWidth * windowHeight);
  const useIntegerBand = rand() < 0.3;
  for (let i = 0; i < band.length; i += 1) {
    const roll = rand();
    if (roll < 0.08) {
      band[i] = -9999;
    } else if (roll < 0.11) {
      band[i] = Number.NaN;
    } else if (roll < 0.12) {
      band[i] = Number.POSITIVE_INFINITY;
    } else {
      band[i] = useIntegerBand ? Math.floor(rand() * 200) : rand() * 5;
    }
  }

  return {
    name: `rand#${index}`,
    width: windowWidth,
    height: windowHeight,
    window: [startCol, startRow, startCol + windowWidth, startRow + windowHeight],
    origin,
    resolution: [resolutionX, resolutionY, 0],
    fenceRings,
    gridCellWidth: geographic ? pick(rand, [10, 25, 60]) : pick(rand, [0.4, 1, 1.7, 5, 12]),
    gridCellHeight: geographic ? pick(rand, [10, 25, 60]) : pick(rand, [0.4, 1, 1.7, 5, 12]),
    band,
    noDataValue: rand() < 0.8 ? -9999 : null,
    rotationDeg: pick(rand, [0, 0, 0, 15, -30, 47, 180]),
    aggregationMode: pick(rand, ['mean', 'max', 'min'] as GridAggregationMode[]),
    metricTransform: geographic
      ? createMetricTransform({
          crsCode: 'EPSG:4326',
          boundingBox: getFenceSummary(fenceRings).bbox,
        })
      : undefined,
  };
}

function expectSameAggregation(caseInput: AggregationCase, actual: GridAggregationResult) {
  const expected = referenceAggregate(caseInput);

  expect(Object.keys(actual.cellsById)).toEqual(Object.keys(expected.cellsById));
  expect(actual).toEqual(expected);
}

describe('网格聚合等价性与性能护栏', () => {
  const rand = mulberry32(20261114);
  const randomCases = Array.from({ length: 30 }, (_, index) => buildCase(rand, index));

  it.each(randomCases.map((testCase) => [testCase.name, testCase] as const))(
    '随机用例 %s 与旧实现逐单元格一致',
    (_name, testCase) => {
      expectSameAggregation(testCase, aggregateGridCellsFromRasterWindow(testCase));
    },
  );

  it.each(randomCases.slice(0, 8).map((testCase) => [testCase.name, testCase] as const))(
    '随机用例 %s 的异步版本与同步版本一致',
    async (_name, testCase) => {
      const sync = aggregateGridCellsFromRasterWindow(testCase);
      const async_ = await aggregateGridCellsFromRasterWindowAsync(testCase, { rowsPerChunk: 1 });
      expect(async_).toEqual(sync);
    },
  );

  it.each(randomCases.slice(0, 6).map((testCase) => [testCase.name, testCase] as const))(
    '随机用例 %s 的波段回填与旧实现一致',
    (_name, testCase) => {
      const aggregation = aggregateGridCellsFromRasterWindow(testCase);
      const secondBand = testCase.band.map((value) => value + 3) as Float32Array;
      const bands = [testCase.band, secondBand];

      const actual = applyGridAggregationToBands({
        bands,
        aggregation,
        width: testCase.width,
        height: testCase.height,
        window: testCase.window,
        origin: testCase.origin,
        resolution: testCase.resolution,
        fenceRings: testCase.fenceRings,
        gridCellWidth: testCase.gridCellWidth,
        gridCellHeight: testCase.gridCellHeight,
        noDataValue: -9999,
        metricTransform: testCase.metricTransform,
        rotationDeg: testCase.rotationDeg,
      });

      const expected = referenceApplyBands({ ...testCase, aggregation, bands });
      expect(actual.bands.map((band) => Array.from(band))).toEqual(expected.map((band) => Array.from(band)));
    },
  );

  it('在 1200x1200 窗口上给出与旧实现的耗时对比', () => {
    const fullWidth = 1200;
    const fullHeight = 1200;
    const cellSize = 6;
    const band = new Float32Array(fullWidth * fullHeight);
    const randLocal = mulberry32(7);
    for (let i = 0; i < band.length; i += 1) {
      band[i] = randLocal() < 0.05 ? -9999 : randLocal() * 10;
    }

    const testCase: AggregationCase = {
      name: 'perf',
      width: fullWidth,
      height: fullHeight,
      window: [0, 0, fullWidth, fullHeight],
      origin: [0, 0],
      resolution: [1, -1, 0],
      fenceRings: [rectangleRing(120, -1080, 1080, -120)],
      gridCellWidth: cellSize,
      gridCellHeight: cellSize,
      band,
      noDataValue: -9999,
      rotationDeg: 0,
      aggregationMode: 'mean',
    };

    const measure = (run: () => GridAggregationResult, times: number) => {
      let result = run();
      const samples: number[] = [];

      for (let i = 0; i < times; i += 1) {
        const start = performance.now();
        result = run();
        samples.push(performance.now() - start);
      }

      return { result, best: Math.min(...samples), samples };
    };

    // 先各跑一次预热 JIT，再取多次最优，避免冷启动把结论带偏
    const optimizedRun = measure(() => aggregateGridCellsFromRasterWindow(testCase), 5);
    const referenceRun = measure(() => referenceAggregate(testCase), 3);

    expect(optimizedRun.result).toEqual(referenceRun.result);
    console.log(
      `[bench] 1200x1200（${((fullWidth * fullHeight) / 1e6).toFixed(2)} M 像元，` +
        `${Object.keys(optimizedRun.result.cellsById).length} 个网格）：优化实现 ${optimizedRun.best.toFixed(1)} ms ` +
        `[${optimizedRun.samples.map((value) => value.toFixed(0)).join('/')}]，` +
        `旧实现 ${referenceRun.best.toFixed(1)} ms [${referenceRun.samples.map((value) => value.toFixed(0)).join('/')}]，` +
        `加速 ${(referenceRun.best / optimizedRun.best).toFixed(1)}x`,
    );
  }, 120_000);
});
