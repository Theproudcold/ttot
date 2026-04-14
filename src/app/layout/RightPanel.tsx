import { useFenceStore } from '@/features/fence/fenceStore';
import { useGridStore } from '@/features/grid/gridStore';
import { useMapUiStore } from '@/features/map/mapUiStore';
import { useRasterStore } from '@/features/map/rasterStore';

function formatRasterPhysicalSize(
  bbox: [number, number, number, number] | null | undefined,
): string {
  if (!bbox) {
    return '--';
  }

  const width = bbox[2] - bbox[0];
  const height = bbox[3] - bbox[1];
  return `${width.toFixed(2)}m x ${height.toFixed(2)}m`;
}

function formatGridRatio(
  cellSize: number,
  bbox: [number, number, number, number] | null | undefined,
): string {
  if (!bbox || cellSize <= 0) {
    return '--';
  }

  const width = bbox[2] - bbox[0];
  const height = bbox[3] - bbox[1];
  if (width <= 0 || height <= 0) {
    return '--';
  }

  const widthRatio = (cellSize / width) * 100;
  const heightRatio = (cellSize / height) * 100;
  return `${widthRatio.toFixed(1)}% / ${heightRatio.toFixed(1)}%`;
}

function formatFenceArea(area: number | null): string {
  if (area === null) {
    return '--';
  }

  return `${area.toFixed(2)} m²`;
}

function formatFenceBbox(bbox: [number, number, number, number] | null): string {
  if (!bbox) {
    return '--';
  }

  return bbox.map((value) => value.toFixed(2)).join(', ');
}

function formatMetricNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return '--';
  }

  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: 2,
  }).format(value);
}

export function RightPanel() {
  const metadata = useRasterStore((state) => state.metadata);
  const status = useRasterStore((state) => state.status);
  const layers = useMapUiStore((state) => state.layers);
  const hoverInfo = useMapUiStore((state) => state.hoverInfo);
  const setLayerVisibility = useMapUiStore((state) => state.setLayerVisibility);
  const fence = useFenceStore((state) => state.fence);
  const cellSize = useGridStore((state) => state.cellSize);
  const gridSummary = useGridStore((state) => state.summary);

  return (
    <aside className="panel" aria-label="right-panel">
      <h2>当前结果</h2>
      <div className="card">
        <dl className="metric-list">
          <div className="metric-item">
            <dt className="metric-label">围栏面积</dt>
            <dd>{formatFenceArea(fence?.summary.area ?? null)}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">围栏顶点</dt>
            <dd>{fence?.summary.vertexCount ?? '--'}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">预计网格数</dt>
            <dd>{gridSummary?.totalCells ?? '--'}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">命中网格数</dt>
            <dd>{gridSummary?.previewCellCount ?? '--'}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">影像状态</dt>
            <dd>{status}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">围栏范围</dt>
            <dd>{formatFenceBbox(fence?.summary.bbox ?? null)}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">参考范围</dt>
            <dd>{metadata ? '已装载' : '--'}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">影像实际尺寸</dt>
            <dd>{formatRasterPhysicalSize(metadata?.boundingBox)}</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">网格比例</dt>
            <dd>{formatGridRatio(cellSize, metadata?.boundingBox)}</dd>
          </div>
        </dl>
      </div>



      <h3>图层</h3>
      <div className="card">
        <label className="toggle-row">
          <span>影像图层</span>
          <input
            aria-label="切换影像图层"
            type="checkbox"
            className="modern-toggle"
            checked={layers.raster}
            onChange={(event) => setLayerVisibility('raster', event.target.checked)}
          />
        </label>
        <label className="toggle-row">
          <span>围栏图层</span>
          <input
            aria-label="切换围栏图层"
            type="checkbox"
            className="modern-toggle"
            checked={layers.fence}
            onChange={(event) => setLayerVisibility('fence', event.target.checked)}
          />
        </label>
        <label className="toggle-row">
          <span>网格图层</span>
          <input
            aria-label="切换网格图层"
            type="checkbox"
            className="modern-toggle"
            checked={layers.grid}
            onChange={(event) => setLayerVisibility('grid', event.target.checked)}
          />
        </label>
      </div>

      <h3>悬停信息</h3>
      <div className="card">
        {hoverInfo ? (
          <dl className="metric-list">
            <div className="metric-item">
              <dt className="metric-label">坐标</dt>
              <dd>{hoverInfo.coordinate.map((value) => value.toFixed(2)).join(', ')}</dd>
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
                  <>
                    <span
                      aria-label="像元分级颜色"
                      className="color-chip"
                      style={{ backgroundColor: hoverInfo.classificationColor }}
                    />
                    {hoverInfo.classificationColor}
                  </>
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
              <dt className="metric-label">网格均值</dt>
              <dd>{formatMetricNumber(hoverInfo.gridMeanValue)}</dd>
            </div>
            <div className="metric-item">
              <dt className="metric-label">有效像元数</dt>
              <dd>{formatMetricNumber(hoverInfo.gridValidPixelCount)}</dd>
            </div>
          </dl>
        ) : (
          '把鼠标移到地图上，右侧会显示当前坐标、像元和值。'
        )}
      </div>
    </aside>
  );
}
