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

export function RightPanel() {
  const metadata = useRasterStore((state) => state.metadata);
  const status = useRasterStore((state) => state.status);
  const layers = useMapUiStore((state) => state.layers);
  const hoverInfo = useMapUiStore((state) => state.hoverInfo);
  const setLayerVisibility = useMapUiStore((state) => state.setLayerVisibility);
  const fence = useFenceStore((state) => state.fence);
  const validationMessage = useFenceStore((state) => state.validationMessage);
  const cellSize = useGridStore((state) => state.cellSize);
  const gridSummary = useGridStore((state) => state.summary);
  const warnings = [validationMessage, gridSummary?.warning].filter(
    (value): value is string => Boolean(value),
  );

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
            <dt className="metric-label">当前预览格网</dt>
            <dd>
              {gridSummary ? `${gridSummary.previewCellCount} / ${gridSummary.totalCells}` : '--'}
            </dd>
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

      <h3>告警提示</h3>
      <div className="card">
        {warnings.length === 0
          ? '当前没有额外告警，网格预览和围栏状态都还算老实。'
          : warnings.map((warning) => <p key={warning}>{warning}</p>)}
      </div>

      <h3>图层</h3>
      <div className="card">
        <label className="toggle-row">
          <span>影像图层</span>
          <input
            aria-label="切换影像图层"
            type="checkbox"
            checked={layers.raster}
            onChange={(event) => setLayerVisibility('raster', event.target.checked)}
          />
        </label>
        <label className="toggle-row">
          <span>围栏图层</span>
          <input
            aria-label="切换围栏图层"
            type="checkbox"
            checked={layers.fence}
            onChange={(event) => setLayerVisibility('fence', event.target.checked)}
          />
        </label>
        <label className="toggle-row">
          <span>网格图层</span>
          <input
            aria-label="切换网格图层"
            type="checkbox"
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
              <dt className="metric-label">有效区域</dt>
              <dd>
                {hoverInfo.inValidityMask === null ? '--' : hoverInfo.inValidityMask ? '是' : '否'}
              </dd>
            </div>
            <div className="metric-item">
              <dt className="metric-label">围栏命中</dt>
              <dd>{hoverInfo.inFence ? '是' : '否'}</dd>
            </div>
            <div className="metric-item">
              <dt className="metric-label">网格单元</dt>
              <dd>{hoverInfo.gridCellId ?? '--'}</dd>
            </div>
          </dl>
        ) : (
          '把鼠标移到地图上，右侧会显示当前坐标、像元和值。'
        )}
      </div>
    </aside>
  );
}
