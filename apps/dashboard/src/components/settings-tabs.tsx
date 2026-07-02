'use client';

import { SidebarMobileToggle } from '@/components/app-sidebar';
import { SETTINGS_TABS, type SettingsTabKey } from '@/lib/settings-nav';

// Settings page header — the mobile sidebar toggle + the active page's title. The
// tab NAVIGATION now lives in the sidebar's Settings mode (see app-sidebar); on a
// phone that nav sits in the drawer, opened via the toggle here. Still named
// "SettingsTabs" so the settings pages keep their existing call unchanged.
export function SettingsTabs({ active }: { active: SettingsTabKey }) {
  const label = SETTINGS_TABS.find((t) => t.key === active)?.label ?? 'Settings';
  return (
    <header className="h-12 px-3 sm:px-4 flex items-center gap-2 border-b border-border shrink-0">
      <SidebarMobileToggle />
      <span className="text-sm font-semibold text-foreground">{label}</span>
    </header>
  );
}
