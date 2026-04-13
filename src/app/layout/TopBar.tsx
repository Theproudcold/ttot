import { useRasterStore } from '@/features/map/rasterStore';

export function TopBar() {
  const metadata = useRasterStore((state) => state.metadata);
  const sourceLabel = useRasterStore((state) => state.sourceLabel);
  const pointerText = useRasterStore((state) => state.pointerText);
  const loadingPhase = useRasterStore((state) => state.loadingPhase);
  const loadingProgress = useRasterStore((state) => state.loadingProgress);
  const validityStatus = useRasterStore((state) => state.validityStatus);

  return (
    <header className="top-bar">
      <div className="top-bar__title">GeoTIFF 围栏网格工具</div>
      <div className="top-bar__meta" aria-label="global-status">
        <span>当前文件：{metadata?.fileName ?? sourceLabel}</span>
        <span>CRS：{metadata?.crsCode ?? '待解析'}</span>
        <span>状态：{loadingPhase}</span>
        <span>读取进度：{loadingProgress === null ? '--' : `${loadingProgress}%`}</span>
        <span>
          有效区域：
          {validityStatus === 'ready'
            ? '已就绪'
            : validityStatus === 'loading'
              ? '后台处理中'
              : validityStatus === 'error'
                ? '提取失败'
                : '--'}
        </span>
        <span>鼠标坐标：{pointerText}</span>
      </div>
    </header>
  );
}
