import { useGridStore } from '@/features/grid/gridStore';
import { useMapUiStore } from '@/features/map/mapUiStore';
import { useRasterStore } from '@/features/map/rasterStore';

import { getCoordinateDecimals, formatMetricNumber } from './classificationUtils';

const AGGREGATION_LABELS: Record<string, string> = {
  mean: '网格均值',
  max: '网格最大值',
  min: '网格最小值',
};

/**
 * 悬停信息卡片。
 * 展示鼠标当前位置对应的坐标、像元、分类及网格聚合信息。
 */
export function HoverInfoCard() {
  const metadata = useRasterStore((state) => state.metadata);
  const hoverInfo = useMapUiStore((state) => state.hoverInfo);
  const aggregationMode = useGridStore((state) => state.aggregationMode);

  if (!hoverInfo) {
    return '把鼠标移到地图上，右侧会显示当前坐标、像元和值。';
  }

  return (
    <dl className="metric-list">
      <div className="metric-item">
        <dt className="metric-label">坐标</dt>
        <dd>{hoverInfo.coordinate.map((value) => value.toFixed(getCoordinateDecimals(metadata))).join(', ')}</dd>
      </div>
      <div className="metric-item">
        <dt className="metric-label">像元位置</dt>
        <dd>{`${hoverInfo.pixel.row} / ${hoverInfo.pixel.col}`}</dd>
      </div>
      <div className="metric-item">
        <dt className="metric-label">像元值</dt>
        <dd>
          {hoverInfo.sampleValues
            ? hoverInfo.sampleValues.map((value) => value.toFixed(2)).join(' / ')
            : '--'}
        </dd>
      </div>
      <div className="metric-item">
        <dt className="metric-label">分类方案</dt>
        <dd>{hoverInfo.classificationLayerName ?? '--'}</dd>
      </div>
      <div className="metric-item">
        <dt className="metric-label">分级区间</dt>
        <dd>{hoverInfo.classificationLabel ?? '--'}</dd>
      </div>
      <div className="metric-item">
        <dt className="metric-label">分级颜色</dt>
        <dd className="metric-color-value">
          {hoverInfo.classificationColor ? (
            <span
              aria-label="像元分级颜色"
              className="color-chip"
              style={{ backgroundColor: hoverInfo.classificationColor }}
            />
          ) : (
            '--'
          )}
        </dd>
      </div>
      <div className="metric-item">
        <dt className="metric-label">围栏命中</dt>
        <dd>{hoverInfo.inFence ? '是' : '否'}</dd>
      </div>
      <div className="metric-item">
        <dt className="metric-label">网格命中</dt>
        <dd>{hoverInfo.gridCellId ?? '--'}</dd>
      </div>
      <div className="metric-item">
        <dt className="metric-label">{AGGREGATION_LABELS[aggregationMode] ?? '网格聚合值'}</dt>
        <dd>{formatMetricNumber(hoverInfo.gridMeanValue)}</dd>
      </div>
      <div className="metric-item">
        <dt className="metric-label">有效像元数</dt>
        <dd>{formatMetricNumber(hoverInfo.gridValidPixelCount)}</dd>
      </div>
    </dl>
  );
}
