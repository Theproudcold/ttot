export function MapView() {
  return (
    <main className="map-panel" aria-label="map-panel">
      <div className="map-panel__header">
        <h2>地图工作区</h2>
        <span className="hint-badge">预览模式：骨架占位</span>
      </div>
      <div className="map-panel__canvas">
        <div className="map-panel__overlay">
          <span className="hint-badge">这里后续挂载 GeoTIFF 和围栏</span>
          <span className="hint-badge">网格预览会根据缩放级别降级显示</span>
        </div>
      </div>
    </main>
  );
}
