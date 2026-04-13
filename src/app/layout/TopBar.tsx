export function TopBar() {
  return (
    <header className="top-bar">
      <div className="top-bar__title">GeoTIFF 围栏网格工具</div>
      <div className="top-bar__meta" aria-label="global-status">
        <span>当前文件：test2.tif</span>
        <span>CRS：待解析</span>
        <span>鼠标坐标：--</span>
      </div>
    </header>
  );
}
