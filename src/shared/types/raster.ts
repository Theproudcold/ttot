import type { CoordinateDisplayMode, MetricExtent, MetricTransform } from '@/shared/geo/crs';

export type RasterBoundingBox = [number, number, number, number];
export type RasterOrigin = [number, number, number?];
export type RasterResolution = [number, number, number?];

export type RasterCellSize = {
  x: number;
  y: number;
  unit: 'm' | 'degree' | 'unknown';
};

export type RasterValueRange = {
  min: number;
  max: number;
};

export type RasterRenderSettings = {
  min: number | null;
  max: number | null;
  step: number;
};

export type RasterClassificationBreak = {
  min: number;
  max: number;
  color: string;
  label: string;
};

export type RasterClassificationMode = 'gradient' | 'rules';

export type RasterGradientStop = {
  value: number;
  color: string;
  label: string;
};

export type RasterClassificationRule = {
  min: number;
  max: number | null;
  color: string;
  label: string;
  /**
   * 施用量数值。其含义由 `applicationRateBasis` 决定：
   * - `per-cell`（默认）：单个网格单元的总量；
   * - `per-area`：单位面积用量，单位见 `applicationRateUnit`。
   */
  applicationRate?: number | null;
  /** 用量基准；缺省按 `per-cell` 处理，保持历史行为 */
  applicationRateBasis?: 'per-cell' | 'per-area';
  /** 单位面积用量的单位；缺省按 `per-hectare` 处理 */
  applicationRateUnit?: 'per-square-meter' | 'per-hectare' | 'per-mu';
};

type RasterClassificationLayerBase = {
  id: string;
  label: string;
  noDataColor: string;
};

export type RasterGradientClassificationLayer = RasterClassificationLayerBase & {
  mode: 'gradient';
  gradientStops: [RasterGradientStop, ...RasterGradientStop[]];
  rules: [];
};

export type RasterRuleClassificationLayer = RasterClassificationLayerBase & {
  mode: 'rules';
  gradientStops: [];
  rules: [RasterClassificationRule, ...RasterClassificationRule[]];
};

export type RasterClassificationLayer =
  | RasterGradientClassificationLayer
  | RasterRuleClassificationLayer;

export type RasterLayerMatchResult = {
  color: string;
  label: string;
  matchedRule: RasterClassificationRule | null;
};

export type RasterValidityMask = {
  width: number;
  height: number;
  boundingBox: RasterBoundingBox;
  data: Uint8Array;
};

export type RasterPreview = {
  url: string;
  width: number;
  height: number;
  sampleBandCount?: number;
  /**
   * 承载影像数据的波段数（已扣除尾部附加波段，如本工具写入的处方波段）。
   * 等于 1 时才按主波段做分类着色；缺省时退回 sampleBandCount。
   */
  classificationBandCount?: number;
  sampleData?: Float32Array;
  sampleRanges?: Array<RasterValueRange | null>;
  noDataValue?: number | null;
};

export type RasterHoverInfo = {
  coordinate: [number, number];
  pixel: {
    row: number;
    col: number;
  };
  sampleValues: number[] | null;
  classificationLayerName?: string | null;
  classificationLabel?: string | null;
  classificationColor?: string | null;
  inValidityMask: boolean | null;
  inFence: boolean;
  gridCellId: string | null;
  gridMeanValue: number | null;
  gridValidPixelCount: number | null;
};

export type RasterHoverInfoInput = Omit<
  RasterHoverInfo,
  'gridMeanValue' | 'gridValidPixelCount'
> & {
  gridMeanValue?: number | null;
  gridValidPixelCount?: number | null;
};

export type RasterMetadata = {
  sourceUrl?: string | null;
  fileName: string;
  width: number;
  height: number;
  samplesPerPixel: number;
  boundingBox: RasterBoundingBox;
  coordinateDisplayMode: CoordinateDisplayMode;
  metricExtent: MetricExtent;
  metricWidth: number;
  metricHeight: number;
  metricTransform: MetricTransform;
  origin: RasterOrigin;
  resolution: RasterResolution;
  cellSize: RasterCellSize;
  crsCode: string;
  crsName: string;
  isProjected: boolean;
};

export type RasterLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export type RasterGeoKeys = Partial<{
  GTCitationGeoKey: string;
  GeographicTypeGeoKey: number;
  ProjectedCSTypeGeoKey: number;
}>;

export type RawRasterMetadata = {
  sourceUrl?: string | null;
  fileName: string;
  width: number;
  height: number;
  boundingBox: RasterBoundingBox;
  origin: RasterOrigin;
  resolution: RasterResolution;
  geoKeys: RasterGeoKeys;
  samplesPerPixel: number;
};

export type LoadedRasterSource = {
  metadata: RasterMetadata;
  validityMask: RasterValidityMask | null;
};

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
        fenceRings: import('@/shared/types/fence').FenceRings;
        window: [number, number, number, number];
        width: number;
        height: number;
        origin: RasterOrigin;
        resolution: RasterResolution;
        band: Float32Array;
        noDataValue: number | null;
        metricTransform: MetricTransform | null;
        gridCellWidth: number;
        gridCellHeight: number;
        aggregationMode: import('@/shared/types/grid').GridAggregationMode;
        rotationDeg: number;
      };
    }
  | {
      id: string;
      type: 'load-preview';
      payload: {
        source: File | string;
        maxEdge: number;
      };
    }
  | {
      id: string;
      type: 'load-validity-mask';
      payload: {
        source: File | string;
      };
    };

export type RasterWorkerResponse =
  | {
      id: string;
      type: 'recolor-preview';
      result: {
        rgbaBuffer: ArrayBuffer;
        width: number;
        height: number;
      };
    }
  | {
      id: string;
      type: 'aggregate-grid';
      result: import('@/shared/types/grid').GridAggregationResult;
    }
  | {
      id: string;
      type: 'load-preview';
      result: {
        rgbaBuffer: ArrayBuffer;
        width: number;
        height: number;
        sampleBandCount: number;
        classificationBandCount: number;
        sampleData: Float32Array;
        sampleRanges: Array<RasterValueRange | null>;
        noDataValue: number | null;
      };
    }
  | {
      id: string;
      type: 'load-validity-mask';
      result: RasterValidityMask;
    }
  | {
      id: string;
      type: 'error';
      error: string;
    };
