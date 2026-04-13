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
  classificationLabel?: string | null;
  classificationColor?: string | null;
  inValidityMask: boolean | null;
  inFence: boolean;
  gridCellId: string | null;
};

export type RasterMetadata = {
  sourceUrl?: string | null;
  fileName: string;
  width: number;
  height: number;
  samplesPerPixel: number;
  boundingBox: RasterBoundingBox;
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
