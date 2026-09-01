'use client';

import { SettingsTabs } from '@/components/settings-tabs';
import { RecycleBinView } from '@/components/recycle-bin-view';

export default function TrashPage() {
  return (
    <div className="flex flex-1 flex-col min-h-0">
      <SettingsTabs active="trash" />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <RecycleBinView />
      </div>
    </div>
  );
}
