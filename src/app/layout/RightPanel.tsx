export function RightPanel() {
  return (
    <aside className="panel" aria-label="right-panel">
      <h2>当前结果</h2>
      <div className="card">
        <dl className="metric-list">
          <div className="metric-item">
            <dt className="metric-label">围栏面积</dt>
            <dd>--</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">预计网格数</dt>
            <dd>--</dd>
          </div>
          <div className="metric-item">
            <dt className="metric-label">导出状态</dt>
            <dd>未开始</dd>
          </div>
        </dl>
      </div>

      <h3>告警提示</h3>
      <div className="card">大格网场景会在这里提示降级预览，别让浏览器硬扛。</div>
    </aside>
  );
}
