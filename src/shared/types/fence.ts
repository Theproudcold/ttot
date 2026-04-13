export type FencePosition = [number, number];
export type FenceRings = FencePosition[][];
export type FenceBoundingBox = [number, number, number, number];

export type FenceSummary = {
  area: number;
  bbox: FenceBoundingBox;
  vertexCount: number;
};

export type FenceFeature = {
  geometry: {
    type: 'Polygon';
    coordinates: FenceRings;
  };
  summary: FenceSummary;
};

export type FenceMode = 'idle' | 'draw' | 'edit';
