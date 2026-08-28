'use client';

import { SettingsTabs } from '@/components/settings-tabs';
import { HostHealthView } from '@/components/host-health-view';
import { GatewayCard } from '@/components/gateway-card';
import { SessionCleanupView } from '@/components/session-cleanup-view';

export default function SystemPage() {
  return (
    <div className="flex flex-1 flex-col min-h-0">
      <SettingsTabs active="system" />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
          <p className="mb-4 text-xs text-muted-foreground">
            Live resource health for the <span className="font-medium text-foreground/80">currently selected machine</span>,
            reported by its gateway. Health is judged on free RAM + load.
          </p>
          <HostHealthView />
          <div className="mt-4">
            <GatewayCard />
          </div>
          <div className="mt-4">
            <SessionCleanupView />
          </div>
        </div>
      </div>
    </div>
  );
}
