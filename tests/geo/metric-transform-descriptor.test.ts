import { describe, expect, it } from 'vitest';

import {
  createIdentityMetricTransform,
  createMetricTransform,
  createMetricTransformFromDescriptor,
} from '@/shared/geo/crs';

const PROJECTED_BBOX: [number, number, number, number] = [447934.57, 4041573.05, 448017.58, 4041619.78];
const GEOGRAPHIC_BBOX: [number, number, number, number] = [119.420001, 36.510001, 119.420901, 36.510601];

describe('MetricTransform 描述符', () => {
  it('投影坐标：重建后的取值与变换函数完全一致', () => {
    const transform = createMetricTransform({ crsCode: 'EPSG:4549', boundingBox: PROJECTED_BBOX });
    const rebuilt = createMetricTransformFromDescriptor(transform.descriptor);

    expect(rebuilt.coordinateDisplayMode).toBe(transform.coordinateDisplayMode);
    expect(rebuilt.metricExtent).toEqual(transform.metricExtent);
    expect(rebuilt.metricWidth).toBe(transform.metricWidth);
    expect(rebuilt.metricHeight).toBe(transform.metricHeight);
    expect(rebuilt.toMetric([447960.5, 4041600.25])).toEqual(transform.toMetric([447960.5, 4041600.25]));
    expect(rebuilt.fromMetric([1234.5, -987.25])).toEqual(transform.fromMetric([1234.5, -987.25]));
  });

  it('地理坐标：重建后逐位一致（局部等距投影按同一公式重建）', () => {
    const transform = createMetricTransform({ crsCode: 'EPSG:4326', boundingBox: GEOGRAPHIC_BBOX });
    const rebuilt = createMetricTransformFromDescriptor(structuredClone(transform.descriptor));

    expect(rebuilt.coordinateDisplayMode).toBe('geographic');
    expect(rebuilt.metricExtent).toEqual(transform.metricExtent);

    for (const point of [
      [119.420001, 36.510001],
      [119.420901, 36.510601],
      [119.42045, 36.5103],
    ] as Array<[number, number]>) {
      expect(rebuilt.toMetric(point)).toEqual(transform.toMetric(point));
    }

    for (const metricPoint of [
      [0, 0],
      [10.5, -7.25],
      [-33.75, 12.125],
    ] as Array<[number, number]>) {
      expect(rebuilt.fromMetric(metricPoint)).toEqual(transform.fromMetric(metricPoint));
    }
  });

  it('恒等变换带 descriptor，且与 createMetricTransform 的投影分支一致', () => {
    const identity = createIdentityMetricTransform(PROJECTED_BBOX);
    const fromCrs = createMetricTransform({ crsCode: 'EPSG:4549', boundingBox: PROJECTED_BBOX });

    expect(identity.descriptor).toEqual(fromCrs.descriptor);
    expect(identity.descriptor.kind).toBe('identity');
  });

  it('变换对象本身不可克隆，但 descriptor 可以——这正是跨线程要传描述的原因', () => {
    const transform = createMetricTransform({ crsCode: 'EPSG:4326', boundingBox: GEOGRAPHIC_BBOX });

    // toMetric/fromMetric 是函数，直接 postMessage 会抛 DataCloneError
    expect(() => structuredClone(transform)).toThrowError(/could not be cloned|DataClone/i);
    expect(() => structuredClone(transform.descriptor)).not.toThrow();
  });
});
