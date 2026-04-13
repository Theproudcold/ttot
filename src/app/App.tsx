import { LeftPanel } from '@/app/layout/LeftPanel';
import { RightPanel } from '@/app/layout/RightPanel';
import { StatusBar } from '@/app/layout/StatusBar';
import { TopBar } from '@/app/layout/TopBar';
import { MapView } from '@/features/map/MapView';

export default function App() {
  return (
    <div className="app-shell">
      <TopBar />
      <div className="workspace">
        <LeftPanel />
        <MapView />
        <RightPanel />
      </div>
      <StatusBar />
    </div>
  );
}
