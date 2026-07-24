'use client';

// Settings → Appearance: pick light / dark, or follow the OS. next-themes persists
// the choice to this browser's localStorage and toggles the `.dark` class on <html>.

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { Monitor, Sun, Moon, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SettingsTabs } from '@/components/settings-tabs';

const OPTIONS = [
  { value: 'system', label: 'System', desc: '跟随系统设置自动切换', Icon: Monitor },
  { value: 'light', label: 'Light', desc: '始终使用亮色', Icon: Sun },
  { value: 'dark', label: 'Dark', desc: '始终使用暗色', Icon: Moon },
] as const;

const MIC_KEY = 'hermit:hide-voice-mic';
function readMicShown() {
  try { return localStorage.getItem(MIC_KEY) !== '1'; } catch { return true; }
}

export default function AppearancePage() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  // theme is unknown on the server / first paint — gate the UI on mount so the
  // selected state doesn't cause a hydration mismatch.
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- standard mount gate
  useEffect(() => setMounted(true), []);
  const current = mounted ? theme ?? 'system' : undefined;

  // Floating voice-mic visibility (localStorage; the chat page reads it on mount
  // + on cross-tab storage events). Default shown.
  const [micShown, setMicShown] = useState(true);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- mount gate reading localStorage
  useEffect(() => setMicShown(readMicShown()), []);
  const toggleMic = () => {
    setMicShown((v) => {
      const next = !v;
      try { localStorage.setItem(MIC_KEY, next ? '0' : '1'); } catch { /* ignore */ }
      return next;
    });
  };

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <SettingsTabs active="appearance" />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl w-full mx-auto p-4 sm:p-6 flex flex-col gap-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">主题外观</h2>
            <p className="text-xs text-muted-foreground mt-1">
              选择亮色 / 暗色，或跟随系统自动切换。该设置保存在这台设备的浏览器里。
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            {OPTIONS.map((o) => {
              const selected = current === o.value;
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setTheme(o.value)}
                  aria-pressed={selected}
                  className={cn(
                    'relative flex flex-col items-start gap-2 rounded-lg border p-3 text-left transition-colors',
                    selected ? 'border-foreground/30 bg-accent' : 'border-border hover:bg-accent/50',
                  )}
                >
                  <span className="flex items-center justify-between w-full">
                    <o.Icon className="h-5 w-5 text-foreground/80" />
                    {selected && <Check className="h-4 w-4 text-emerald-500" />}
                  </span>
                  <span className="text-sm font-medium text-foreground">{o.label}</span>
                  <span className="text-[11px] text-muted-foreground leading-snug">{o.desc}</span>
                </button>
              );
            })}
          </div>

          <p className="text-[11px] text-muted-foreground min-h-[1rem]">
            {mounted
              ? current === 'system'
                ? `当前跟随系统 — 现在是${resolvedTheme === 'dark' ? '暗色' : '亮色'}。`
                : `已固定为${current === 'dark' ? '暗色' : '亮色'}。`
              : null}
          </p>

          <div className="border-t border-border pt-4">
            <h2 className="text-sm font-semibold text-foreground">Voice input</h2>
            <p className="text-xs text-muted-foreground mt-1">
              A floating mic button in chat — hold to talk and your speech is transcribed into the composer; drag to
              reposition. Saved on this device.
            </p>
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border p-3">
              <span className="text-sm text-foreground">Show the floating mic button</span>
              <button
                type="button"
                role="switch"
                aria-checked={mounted ? micShown : undefined}
                aria-label="Show the floating mic button"
                onClick={toggleMic}
                className={cn(
                  'relative h-6 w-11 shrink-0 rounded-full transition-colors cursor-pointer',
                  mounted && micShown ? 'bg-emerald-500' : 'bg-muted',
                )}
              >
                <span
                  className={cn(
                    'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
                    mounted && micShown ? 'translate-x-[22px]' : 'translate-x-0.5',
                  )}
                />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
