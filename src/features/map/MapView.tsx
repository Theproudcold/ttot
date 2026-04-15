import { useRasterStore } from '@/features/map/rasterStore';
import { useFenceStore } from '@/features/fence/fenceStore';
import { useMapUiStore } from '@/features/map/mapUiStore';
import { buildRasterClassificationLegendData } from '@/shared/geo/raster';

import { useMap } from './useMap';
import { useRasterLoader } from './useRasterLoader';

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

function MapHoverCard() {
  const metadata = useRasterStore((state) => state.metadata);
  const hoverInfo = useMapUiStore((state) => state.hoverInfo);

  if (!hoverInfo) {
    return null;
  }

  const decimals = metadata?.coordinateDisplayMode === 'geographic' ? 6 : 2;

  return (
    <div className="hover-card" aria-label="hover-card">
      <div>{`坐标：${hoverInfo.coordinate[0].toFixed(decimals)}, ${hoverInfo.coordinate[1].toFixed(decimals)}`}</div>
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
      <div>{`网格均值：${hoverInfo.gridMeanValue?.toFixed(2) ?? '--'}`}</div>
      <div>{`有效像元：${hoverInfo.gridValidPixelCount ?? '--'}`}</div>
    </div>
  );
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
  const legendData =
    preview?.sampleBandCount === 1 && visibleClassificationLayer
      ? buildRasterClassificationLegendData(visibleClassificationLayer)
      : null;
  const gradientLegendStartLabel =
    legendData?.mode === 'gradient' ? (legendData.items[0]?.label ?? null) : null;
  const gradientLegendEndLabel =
    legendData?.mode === 'gradient'
      ? (legendData.items[legendData.items.length - 1]?.label ?? null)
      : null;

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
        <MapHoverCard />
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
