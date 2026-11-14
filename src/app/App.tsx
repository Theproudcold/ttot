import { useState } from 'react';

import { LeftPanel } from '@/app/layout/LeftPanel';
import { LoadingOverlay } from '@/app/layout/LoadingOverlay';
import { RightPanel } from '@/app/layout/RightPanel';
import { TopBar } from '@/app/layout/TopBar';
import { MapView } from '@/features/map/MapView';
import { AlertOverlay } from '@/app/layout/AlertOverlay';
import { applyProjectSnapshot } from '@/features/project/applyProjectSnapshot';
import { clearDraft, readDraft } from '@/features/project/draftStorage';
import {
  buildRestorePlan,
  fingerprintFromFile,
  type ProjectSnapshotV1,
} from '@/features/project/projectSnapshot';
import { useDraftPersistence } from '@/features/project/useDraftPersistence';
import { useRasterStore } from '@/features/map/rasterStore';

type PendingDraft = {
  snapshot: ProjectSnapshotV1;
  savedAt: string;
  warnings: string[];
};

function formatSavedAt(savedAt: string): string {
  const parsed = new Date(savedAt);

  return Number.isNaN(parsed.getTime()) ? savedAt : parsed.toLocaleString();
}

export default function App() {
  // 持续写入本地草稿；是否恢复由下面的提示决定
  useDraftPersistence();

  // 在首次渲染时就取草稿，避免草稿写入订阅先一步覆盖旧内容
  const [pendingDraft, setPendingDraft] = useState<PendingDraft | null>(() => readDraft());
  const [restoreNotice, setRestoreNotice] = useState<string[]>([]);

  const handleRestoreDraft = () => {
    if (!pendingDraft) {
      return;
    }

    const raster = useRasterStore.getState();
    const plan = buildRestorePlan({
      snapshot: pendingDraft.snapshot,
      currentFingerprint: raster.sourceFile ? fingerprintFromFile(raster.sourceFile) : null,
      currentCrsCode: raster.metadata?.crsCode ?? null,
      currentBoundingBox: raster.metadata?.boundingBox ?? null,
    });

    // blocked 表示保存的状态与当前影像不可比（CRS 不一致 / 围栏越界），此时不自动还原
    if (plan.action !== 'blocked') {
      applyProjectSnapshot(pendingDraft.snapshot);
    }

    setRestoreNotice([...plan.errors, ...plan.warnings, ...pendingDraft.warnings]);
    setPendingDraft(null);
  };

  const handleDiscardDraft = () => {
    clearDraft();
    setPendingDraft(null);
  };

  return (
    <div className="app-shell">
      <TopBar />
      <div className="workspace">
        <LeftPanel />
        <MapView />
        <RightPanel />
      </div>
      <LoadingOverlay />
      <AlertOverlay />
      {(pendingDraft || restoreNotice.length > 0) && (
        <div className="alert-overlay" role="status" aria-label="draft-restore">
          {pendingDraft && (
            <div className="alert-toast">
              <span className="alert-toast__icon">💾</span>
              <span className="alert-toast__text">
                检测到 {formatSavedAt(pendingDraft.savedAt)} 的工作草稿，是否恢复？
              </span>
              <div className="toolbar-row">
                <button type="button" className="toolbar-button" onClick={handleRestoreDraft}>
                  恢复
                </button>
                <button
                  type="button"
                  className="toolbar-button toolbar-button--ghost"
                  onClick={handleDiscardDraft}
                >
                  忽略
                </button>
              </div>
            </div>
          )}
          {restoreNotice.map((notice, index) => (
            <div key={`${notice}-${index}`} className="alert-toast">
              <span className="alert-toast__icon">⚠️</span>
              <span className="alert-toast__text">{notice}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
