export function LeftPanel() {
  return (
    <aside className="panel" aria-label="left-panel">
      <h2>文件信息</h2>
      <div className="card">
        <dl className="metric-list">
          <div className="metric-item">
            <dt className="metric-label">文件名</dt>
            <dd>test2.tif</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">地理参考</dt>
            <dd>待读取</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">网格单位</dt>
            <dd>米</dd>
          </div>
        </dl>
      </div>

      <h3>围栏工具</h3>
      <div className="card">先放工具栏占位，下一步接 OpenLayers 绘制。</div>

      <h3>网格参数</h3>
      <div className="card">先放网格尺寸和预估数量占位，后面接实时预览。</div>
    </aside>
  );
}
