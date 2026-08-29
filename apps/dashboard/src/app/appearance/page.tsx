'use client';

// Settings → Appearance: pick light / dark, or follow the OS. next-themes persists
// the choice to this browser's localStorage and toggles the `.dark` class on <html>.

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { Monitor, Sun, Moon, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SettingsTabs } from '@/components/settings-tabs';
import { readTranslatePrefs, writeTranslatePrefs, DEFAULT_PREFS, type TranslatePrefs } from '@/lib/translate-prefs';

const OPTIONS = [
  { value: 'system', label: 'System', desc: '跟随系统设置自动切换', Icon: Monitor },
  { value: 'light', label: 'Light', desc: '始终使用亮色', Icon: Sun },
  { value: 'dark', label: 'Dark', desc: '始终使用暗色', Icon: Moon },
] as const;

// One switch, four uses. There is still no `ui/switch` in this app (see the
// note in app/backends/page.tsx about why a second toggle STYLE is how two of
// them drift) — this is that same markup, lifted to a local component now that
// the page has more than one.
//
// The knob rides IN FLOW (inline-flex track + items-center), the way the
// switches on Global Memory and Backends do, and NOT absolutely positioned.
// The absolute version this page used to carry looked right on a wide screen
// and was wrong everywhere: a `<button>` has `text-align: center` from the UA
// stylesheet, and an absolutely-positioned child with no `left` takes its
// STATIC position from that centring — 22px into a 44px track. The transform
// then added its 2px/22px on top, so the knob sat 22px right of where it should
// and, when on, entirely outside the track. Measured on a 390px viewport:
// track 317→361, knob 361→381.
function Switch({
  checked,
  onToggle,
  label,
  mounted,
  disabled = false,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  mounted: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={mounted ? checked : undefined}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors cursor-pointer',
        disabled && 'opacity-40 cursor-not-allowed',
        mounted && checked ? 'bg-emerald-500' : 'bg-muted',
      )}
    >
      <span
        className={cn(
          'inline-block h-5 w-5 rounded-full bg-white shadow transition-transform',
          mounted && checked ? 'translate-x-[22px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

function SettingRow({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
      <div className="min-w-0">
        <div className="text-sm text-foreground">{title}</div>
        {desc && <div className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

export default function AppearancePage() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  // theme is unknown on the server / first paint — gate the UI on mount so the
  // selected state doesn't cause a hydration mismatch.
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- standard mount gate
  useEffect(() => setMounted(true), []);
  const current = mounted ? theme ?? 'system' : undefined;

  // Translation (localStorage; chat reads it through useTranslatePrefs, which
  // subscribes to both the same-tab event and cross-tab `storage`).
  const [translate, setTranslate] = useState<TranslatePrefs>(DEFAULT_PREFS);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- mount gate reading localStorage
  useEffect(() => setTranslate(readTranslatePrefs()), []);
  const patchTranslate = (patch: Partial<TranslatePrefs>) => {
    setTranslate((cur) => {
      const next = { ...cur, ...patch };
      writeTranslatePrefs(next);
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
            <h2 className="text-sm font-semibold text-foreground">语音输入</h2>
            <p className="text-xs text-muted-foreground mt-1">
              在聊天输入框上<strong className="font-medium">按住</strong>就开始说话，松手发送；按住时手指滑到左边取消，
              滑到右边把这段话放进输入框再改。想边说边改，就点输入框右边的麦克风，说的话会一个字一个字写进去。
              桌面端按住右侧 ⌥ 也能说话。
            </p>
          </div>

          <div className="border-t border-border pt-4">
            <h2 className="text-sm font-semibold text-foreground">翻译</h2>
            <p className="text-xs text-muted-foreground mt-1">
              把 agent 发来的英文回复翻成中文，把你写的中文翻成英文再发出去。翻译只发生在这个浏览器里 —— 收到的
              英文原文一直都在（点消息下方的「原文」），只有<strong className="font-medium">发出去</strong>的那条是
              agent 真正读到的内容。这台设备上生效。
            </p>
            <div className="mt-3 flex flex-col gap-2">
              <SettingRow title="启用翻译" desc="关闭时不发任何翻译请求，消息下方也不显示「译」按钮。">
                <Switch
                  checked={translate.on}
                  onToggle={() => patchTranslate({ on: !translate.on })}
                  mounted={mounted}
                  label="启用翻译"
                />
              </SettingRow>
              <SettingRow
                title="自动翻译收到的英文"
                desc="英文回复边写边翻，中文逐段接上；还没翻到的部分在下方灰字里跟着走。"
              >
                <Switch
                  checked={translate.autoIn}
                  onToggle={() => patchTranslate({ autoIn: !translate.autoIn })}
                  mounted={mounted}
                  label="自动翻译收到的英文"
                  disabled={!translate.on}
                />
              </SettingRow>
              <SettingRow
                title="自动翻译发出的中文"
                desc="发送前把中文转成英文交给 agent。你的气泡仍然显示你打的中文，点「EN」看实际发出去的内容。"
              >
                <Switch
                  checked={translate.autoOut}
                  onToggle={() => patchTranslate({ autoOut: !translate.autoOut })}
                  mounted={mounted}
                  label="自动翻译发出的中文"
                  disabled={!translate.on}
                />
              </SettingRow>
            </div>
            {mounted && translate.on && translate.autoOut && (
              <p className="text-[11px] text-amber-600 dark:text-amber-500 mt-2 leading-snug">
                发出去的内容改不回来了 —— 翻译错了也已经进了对话记录。另外，agent 如果自己被设定成用中文回复，
                你发英文过去它还是回中文，「自动翻译收到的英文」就一直用不上。
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
