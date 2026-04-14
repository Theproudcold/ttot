import { LeftPanel } from '@/app/layout/LeftPanel';
import { RightPanel } from '@/app/layout/RightPanel';
import { TopBar } from '@/app/layout/TopBar';
import { MapView } from '@/features/map/MapView';
import { AlertOverlay } from '@/app/layout/AlertOverlay';

export default function App() {
  return (
    <div className="app-shell">
      <TopBar />
      <div className="workspace">
        <LeftPanel />
        <MapView />
        <RightPanel />
      </div>
      <AlertOverlay />
    </div>
  );
}

