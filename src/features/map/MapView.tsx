import { useRasterStore } from '@/features/map/rasterStore';
import { useFenceStore } from '@/features/fence/fenceStore';
import { useMapUiStore } from '@/features/map/mapUiStore';
import { buildRasterClassificationLegendData } from '@/shared/geo/raster';

import { useMap } from './useMap';
import { useRasterLoader } from './useRasterLoader';
import { canClassifySingleBand } from './mapUtils';

function getVisibleClassificationLayer(
  classificationLayers: ReturnType<typeof useMapUiStore.getState>['classificationLayers'],
  visibleClassificationLayerId: string | null,
) {
  if (visibleClassificationLayerId) {
    const preferredLayer = classificationLayers.find((layer) => layer.id === visibleClassificationLayerId);
    if (preferredLayer?.visible) {
      return preferredLayer;
    }
  }

  return classificationLayers.find((layer) => layer.visible) ?? null;
}

export function MapView() {
  useRasterLoader();

  const metadata = useRasterStore((state) => state.metadata);
  const classificationLayers = useMapUiStore((state) => state.classificationLayers);
  const visibleClassificationLayerId = useMapUiStore((state) => state.visibleClassificationLayerId);
  const previewStatus = useRasterStore((state) => state.previewStatus);
  const status = useRasterStore((state) => state.status);
  const error = useRasterStore((state) => state.error);
  const loadingProgress = useRasterStore((state) => state.loadingProgress);
  const validityStatus = useRasterStore((state) => state.validityStatus);
  const preview = useRasterStore((state) => state.preview);
  const fence = useFenceStore((state) => state.fence);
  const { mapElementRef, fitToRaster, fitToFence } = useMap(metadata);
  const visibleClassificationLayer = getVisibleClassificationLayer(
    classificationLayers,
    visibleClassificationLayerId,
  );
  // 必须与 useMap 的着色判定一致：rules 模式导出的文件带有追加的处方波段，
  // 用 sampleBandCount 判断会让这类文件「地图着色但图例消失」。
  const legendData =
    canClassifySingleBand(preview) && visibleClassificationLayer
      ? buildRasterClassificationLegendData(visibleClassificationLayer)
      : null;
  const gradientLegendStartLabel =
    legendData?.mode === 'gradient' ? (legendData.items[0]?.label ?? null) : null;
  const gradientLegendEndLabel =
    legendData?.mode === 'gradient'
      ? (legendData.items[legendData.items.length - 1]?.label ?? null)
      : null;

  const overlayStatusText =
    error ||
    (previewStatus === 'loading'
      ? '正在生成可预览影像'
      : status === 'loading'
        ? `读取进度 ${loadingProgress ?? '--'}%`
        : validityStatus === 'loading'
          ? '影像已显示，正在后台准备有效区域'
          : null);

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
          {overlayStatusText ? <span className="hint-badge">{overlayStatusText}</span> : null}
        </div>
        {legendData && visibleClassificationLayer ? (
          <div className="legend-card" aria-label="raster-legend">
            <div className="legend-card__title">{visibleClassificationLayer.label}</div>
            {legendData.mode === 'gradient' && legendData.gradientCss ? (
              <>
                <div
                  aria-label="gradient-legend"
                  style={{
                    height: '14px',
                    borderRadius: '999px',
                    border: '1px solid rgba(0, 0, 0, 0.08)',
                    background: legendData.gradientCss,
                  }}
                />
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '12px',
                    fontSize: '12px',
                    color: '#4a4a4a',
                  }}
                >
                  <span>{gradientLegendStartLabel}</span>
                  <span>{gradientLegendEndLabel}</span>
                </div>
              </>
            ) : null}
            {legendData.mode === 'rules' ? (
              <div className="legend-list">
                {legendData.items.map((item) => (
                  <div key={item.label} className="legend-item">
                    <span className="color-chip" style={{ backgroundColor: item.color }} />
                    <span>{item.label}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </main>
  );
}
