// Shared keyboard-shortcut definitions — the single source for the global handler
// (components/keyboard-shortcuts.tsx) and the Help dialog's shortcuts table.
// Shortcuts are active only in the installed PWA (standalone); see isStandalone().

export type ShortcutGroup = 'Navigation' | 'Actions' | 'General';

export interface Shortcut {
  id: string;
  keys: string[]; // display tokens, e.g. ['⌘', 'K']
  label: string;
  group: ShortcutGroup;
  href?: string; // navigation target (for nav shortcuts)
}

export const SHORTCUTS: Shortcut[] = [
  { id: 'search', keys: ['⌘', 'K'], label: 'Focus search', group: 'Actions' },
  { id: 'new-chat', keys: ['⌘', '⇧', 'N'], label: 'New chat', group: 'Actions' },
  { id: 'nav-chat', keys: ['⌘', '1'], label: 'Go to Chat', group: 'Navigation', href: '/chat' },
  { id: 'nav-agents', keys: ['⌘', '2'], label: 'Go to Agents', group: 'Navigation', href: '/agents' },
  { id: 'nav-cron', keys: ['⌘', '3'], label: 'Go to Cron', group: 'Navigation', href: '/cron' },
  { id: 'nav-notifications', keys: ['⌘', '4'], label: 'Go to Notifications', group: 'Navigation', href: '/notifications' },
  { id: 'nav-brain', keys: ['⌘', '5'], label: 'Go to Brain', group: 'Navigation', href: '/brain' },
  { id: 'nav-settings', keys: ['⌘', '6'], label: 'Go to Settings', group: 'Navigation', href: '/skills' },
  { id: 'help', keys: ['?'], label: 'Open Help', group: 'General' },
  { id: 'close', keys: ['Esc'], label: 'Close dialog / overlay', group: 'General' },
];

// The Help dialog (sidebar Help button + the ? shortcut) is toggled via a window
// event so the trigger and the dialog (mounted in providers) stay decoupled —
// dispatch toggleHelp() from anywhere; <HelpDialog/> listens. Lives here (pure,
// no JSX) so both keyboard-shortcuts and help-dialog import it without a cycle.
export const HELP_EVENT = 'hermit:toggle-help';
export function toggleHelp() {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(HELP_EVENT));
}

// True only in an installed PWA window (standalone display-mode). The user scoped
// shortcuts to "PWA mode"; gating here also avoids ⌘1-6 clashing with the browser's
// own tab-switching (a standalone window has no tabs).
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)')?.matches === true ||
    (navigator as unknown as { standalone?: boolean }).standalone === true // iOS home-screen
  );
}
