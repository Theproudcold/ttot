import { useRasterStore } from '@/features/map/rasterStore';
import { useFenceStore } from '@/features/fence/fenceStore';
import { useMapUiStore } from '@/features/map/mapUiStore';
import { buildClassificationBreaks } from '@/shared/geo/raster';

import { useMap } from './useMap';
import { useRasterLoader } from './useRasterLoader';

export function MapView() {
  useRasterLoader();

  const metadata = useRasterStore((state) => state.metadata);
  const hoverInfo = useMapUiStore((state) => state.hoverInfo);
  const rasterRenderSettings = useMapUiStore((state) => state.rasterRenderSettings);
  const previewStatus = useRasterStore((state) => state.previewStatus);
  const status = useRasterStore((state) => state.status);
  const error = useRasterStore((state) => state.error);
  const loadingProgress = useRasterStore((state) => state.loadingProgress);
  const validityStatus = useRasterStore((state) => state.validityStatus);
  const preview = useRasterStore((state) => state.preview);
  const fence = useFenceStore((state) => state.fence);
  const { mapElementRef, fitToRaster, fitToFence } = useMap(metadata);
  const classificationBreaks = buildClassificationBreaks(
    preview?.sampleBandCount === 1 ? (preview.sampleRanges?.[0] ?? null) : null,
    rasterRenderSettings,
  );

  return (
    <main className="map-panel" aria-label="map-panel">
      <div className="map-panel__header">
        <h2>地图工作区</h2>
        <div className="toolbar-row">
          <button type="button" className="toolbar-button toolbar-button--ghost" onClick={fitToRaster}>
            适配影像
          </button>
          <button
            type="button"
            className="toolbar-button toolbar-button--ghost"
            onClick={fitToFence}
            disabled={!fence}
          >
            适配围栏
          </button>
        </div>
        <span className="hint-badge">
          {previewStatus === 'ready'
            ? 'GeoTIFF 预览已准备'
            : previewStatus === 'error'
              ? '预览生成失败'
              : status === 'error'
                ? '加载失败'
                : '正在读取 GeoTIFF'}
        </span>
      </div>
      <div className="map-panel__canvas" ref={mapElementRef}>
        <div className="map-panel__overlay">
          <span className="hint-badge">
            {metadata ? `${metadata.fileName} · ${metadata.crsCode}` : '这里后续挂载 GeoTIFF 和围栏'}
          </span>
          <span className="hint-badge">
            {error ||
              (previewStatus === 'loading'
                ? '正在生成可预览影像'
                : status === 'loading'
                ? `读取进度 ${loadingProgress ?? '--'}%`
                : validityStatus === 'loading'
                  ? '影像已显示，正在后台准备有效区域'
                  : '网格预览会根据缩放级别降级显示')}
          </span>
        </div>
        {hoverInfo ? (
          <div className="hover-card" aria-label="hover-card">
            <div>{`坐标：${hoverInfo.coordinate[0].toFixed(2)}, ${hoverInfo.coordinate[1].toFixed(2)}`}</div>
            <div>{`像元：${hoverInfo.pixel.row} / ${hoverInfo.pixel.col}`}</div>
            <div>
              {`像元值：${
                hoverInfo.sampleValues
                  ? hoverInfo.sampleValues.map((value) => value.toFixed(2)).join(' / ')
                  : '--'
              }`}
            </div>
            <div>{`分级区间：${hoverInfo.classificationLabel ?? '--'}`}</div>
            <div>{`命中围栏：${hoverInfo.inFence ? '是' : '否'}`}</div>
            <div>{`命中网格：${hoverInfo.gridCellId ?? '--'}`}</div>
          </div>
        ) : null}
        {classificationBreaks.length > 0 ? (
          <div className="legend-card" aria-label="raster-legend">
            <div className="legend-card__title">色带图例</div>
            <div className="legend-list">
              {classificationBreaks.map((item) => (
                <div key={item.label} className="legend-item">
                  <span className="color-chip" style={{ backgroundColor: item.color }} />
                  <span>{item.label}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}
