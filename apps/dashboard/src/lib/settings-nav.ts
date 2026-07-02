// The Settings sub-navigation, shared by the tab strip (components/settings-tabs)
// and the sidebar's Settings-active check (components/app-sidebar). Data only (no
// JSX) so both can import it without a cycle — app-sidebar ↔ settings-tabs already
// depend on each other. This is also the source the future Settings sidebar reads.

import { Boxes, BarChart3, Wrench, HardDriveUpload, Brain, SunMoon, Activity, HelpCircle, type LucideIcon } from 'lucide-react';

export type SettingsTabKey =
  | 'skills' | 'memory' | 'usage' | 'ops' | 'system' | 'files' | 'appearance' | 'help';

export const SETTINGS_TABS: { key: SettingsTabKey; label: string; href: string; Icon: LucideIcon }[] = [
  { key: 'usage', label: 'Usage', href: '/usage', Icon: BarChart3 },
  { key: 'skills', label: 'Global Skills', href: '/skills', Icon: Boxes },
  { key: 'memory', label: 'Global Memory', href: '/global-memory', Icon: Brain },
  { key: 'ops', label: 'Operations', href: '/ops', Icon: Wrench },
  { key: 'system', label: 'System', href: '/system', Icon: Activity },
  { key: 'files', label: 'File Station', href: '/file-station', Icon: HardDriveUpload },
  { key: 'appearance', label: 'Appearance', href: '/appearance', Icon: SunMoon },
  { key: 'help', label: 'Help', href: '/help', Icon: HelpCircle },
];

// Where the Settings gear (and the ⌘-Settings shortcut) lands — the first tab. Kept
// as one export so the entry point and the nav order share a single source of truth.
export const SETTINGS_ENTRY_HREF: string = SETTINGS_TABS[0].href;

// Route prefixes that belong to the Settings area — used to light up the sidebar's
// Settings entry on any of them.
export const SETTINGS_HREFS: string[] = SETTINGS_TABS.map((t) => t.href);
