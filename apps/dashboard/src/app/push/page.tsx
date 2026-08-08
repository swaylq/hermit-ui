'use client';

// Settings → Push: turn on lock-screen notifications for this machine.
//
// Two routes onto an iPhone, neither of which needs an app to be developed or a
// paid Apple Developer account (docs/no-app-push-design.md):
//
//   Web Push — this PWA, once it's on the Home Screen. Our icon, taps land back
//              in the app. Subscribed from this page.
//   Bark     — a free App Store relay. Paste the key it shows you. Dumber, but it
//              does not lapse the way an unopened Home Screen web app does.
//
// The native shell (apps/ios) still registers itself and shows up in the list
// below; there is nothing to configure for it here.

import { useCallback, useEffect, useState } from 'react';
import { BellRing, Smartphone, Globe, Send, Trash2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { SettingsTabs } from '@/components/settings-tabs';
import {
  currentEndpoint,
  isStandalone,
  notificationPermission,
  pushSupport,
  subscribeWebPush,
  unsubscribeWebPush,
} from '@/lib/web-push-client';

const PLATFORM_LABEL: Record<string, string> = {
  web: 'Web Push (PWA)',
  bark: 'Bark',
  ios: 'Native app',
};

export default function PushSettingsPage() {
  const utils = trpc.useUtils();
  const status = trpc.push.status.useQuery();
  const devices = trpc.push.list.useQuery();

  const refresh = useCallback(() => {
    void utils.push.status.invalidate();
    void utils.push.list.invalidate();
  }, [utils]);

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <SettingsTabs active="push" />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl w-full mx-auto p-4 sm:p-6 flex flex-col gap-6">
          <div>
            <h2 className="text-sm font-semibold text-foreground">推送通知</h2>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              agent 回复、卡在权限确认上、定时任务失败、机器资源告警，都会推到手机锁屏。
              下面两条路都<span className="text-foreground/80">不需要开发 app，也不需要付费 Apple 开发者账号</span>；
              两个一起开也可以，同一条通知会按会话折叠，不会响两次。
            </p>
          </div>

          <WebPushCard
            vapidPublicKey={status.data?.vapidPublicKey ?? null}
            onChange={refresh}
          />

          <BarkCard
            defaultServer={status.data?.defaultBarkServer ?? 'https://api.day.app'}
            onChange={refresh}
          />

          <DeviceList
            rows={devices.data ?? []}
            loading={devices.isLoading}
            onChange={refresh}
          />
        </div>
      </div>
    </div>
  );
}

// ── Web Push ────────────────────────────────────────────────────────────────

function WebPushCard({
  vapidPublicKey,
  onChange,
}: {
  vapidPublicKey: string | null;
  onChange: () => void;
}) {
  // All three read browser-only APIs, so they stay null until mount.
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [permission, setPermission] = useState<string | null>(null);
  const [standalone, setStandalone] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const sync = useCallback(() => {
    setPermission(notificationPermission());
    setStandalone(isStandalone());
    void currentEndpoint().then(setEndpoint);
  }, []);

  // Mount gate: permission, display-mode and the SW subscription are browser-only
  // and absent during SSR, so they can only be read after the first render.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- standard mount gate
  useEffect(sync, [sync]);

  const support = pushSupport(vapidPublicKey);

  const subscribe = async () => {
    if (!vapidPublicKey) return;
    setBusy(true);
    setMsg(null);
    try {
      // Called straight from the click: iOS only honours requestPermission when
      // it can attribute it to a user gesture.
      const r = await subscribeWebPush(vapidPublicKey);
      setMsg(
        r.ok
          ? `已订阅 — ${r.registered}/${r.of} 台机器会推到这台设备`
          : r.reason === 'denied'
            ? '系统通知权限被拒绝。到 iOS 设置 → 通知 → Hermit 里打开。'
            : r.reason === 'no-machines'
              ? '钥匙串里还没有机器。'
              : '订阅失败，请重试。',
      );
      sync();
      onChange();
    } catch (e) {
      setMsg(`订阅失败：${String(e).slice(0, 120)}`);
    } finally {
      setBusy(false);
    }
  };

  const unsubscribe = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await unsubscribeWebPush();
      setMsg('已取消订阅。');
      sync();
      onChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-border p-4">
      <div className="flex items-start gap-3">
        <Globe className="h-5 w-5 shrink-0 text-foreground/70 mt-0.5" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">Web Push · 这个 PWA 自己</h3>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            通知显示 Hermit 的图标，点开直接回到对应会话。需要先把网页
            <span className="text-foreground/80">「添加到主屏幕」</span>并从主屏图标打开 —— iOS 只给主屏 Web App 推送权限，Safari 标签页里没有。
          </p>

          {/* Only render browser-dependent state after mount, so SSR and the first
              paint agree. */}
          {standalone === null ? null : !support.ok ? (
            <Notice
              tone="warn"
              text={
                support.reason === 'no-vapid-key'
                  ? '服务端还没有配置 VAPID 密钥（VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT）。生成方式见 docs/no-app-push-design.md。'
                  : support.reason === 'needs-install'
                    ? '还没装到主屏。点 Safari 分享按钮 → 添加到主屏幕，然后从主屏图标重新打开这个页面。'
                    : '这个浏览器不支持 Web Push。'
              }
            />
          ) : endpoint ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs text-emerald-500">
                <CheckCircle2 className="h-3.5 w-3.5" /> 这台设备已订阅
              </span>
              <button
                type="button"
                onClick={unsubscribe}
                disabled={busy}
                className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-50"
              >
                取消订阅
              </button>
            </div>
          ) : (
            <div className="mt-3">
              <button
                type="button"
                onClick={subscribe}
                disabled={busy}
                className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90 disabled:opacity-50"
              >
                {busy ? '订阅中…' : '在这台设备上开启推送'}
              </button>
              {permission === 'denied' && (
                <Notice tone="warn" text="通知权限此前被拒绝过 —— 先到 iOS 设置 → 通知 里放行，再回来点一次。" />
              )}
            </div>
          )}

          {msg && <p className="mt-2 text-[11px] text-muted-foreground">{msg}</p>}
        </div>
      </div>
    </section>
  );
}

// ── Bark ────────────────────────────────────────────────────────────────────

function BarkCard({ defaultServer, onChange }: { defaultServer: string; onChange: () => void }) {
  const [deviceKey, setDeviceKey] = useState('');
  const [server, setServer] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const register = trpc.push.registerBark.useMutation({
    onSuccess: (r) => {
      setMsg(`已添加，走 ${r.server}`);
      setDeviceKey('');
      onChange();
    },
    onError: (e) => setMsg(`失败：${e.message}`),
  });

  return (
    <section className="rounded-lg border border-border p-4">
      <div className="flex items-start gap-3">
        <Smartphone className="h-5 w-5 shrink-0 text-foreground/70 mt-0.5" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">Bark · 免费 App Store 中转</h3>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            App Store 装 <span className="text-foreground/80">Bark</span>，打开后它会给你一串 device key，粘到下面即可。
            锁屏上显示的是 Bark 的图标，点开在 Safari 里打开对应页面。
            它不像主屏 Web App 那样会因为长期没打开而掉订阅，适合当兜底。
          </p>

          <div className="mt-3 flex flex-col gap-2">
            <input
              value={deviceKey}
              onChange={(e) => setDeviceKey(e.target.value.trim())}
              placeholder="device key，例如 dQw4w9WgXcQ1a2b3c4d5e"
              spellCheck={false}
              autoCapitalize="none"
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs outline-none focus:border-foreground/30"
            />
            <input
              value={server}
              onChange={(e) => setServer(e.target.value.trim())}
              placeholder={`自建服务器（可选），留空用 ${defaultServer}`}
              spellCheck={false}
              autoCapitalize="none"
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs outline-none focus:border-foreground/30"
            />
            <div>
              <button
                type="button"
                disabled={!deviceKey || register.isPending}
                onClick={() =>
                  register.mutate({ deviceKey, ...(server ? { server } : {}) })
                }
                className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90 disabled:opacity-50"
              >
                {register.isPending ? '添加中…' : '添加这台 Bark 设备'}
              </button>
            </div>
          </div>

          <p className="mt-2 text-[11px] text-muted-foreground leading-relaxed">
            不想让公共服务器看到 agent 的聊天摘要，就在自己的 VPS 上
            <code className="mx-1 rounded bg-muted px-1 py-0.5">docker run -d -p 8080:8080 -v ./bark-data:/data finab/bark-server</code>
            再把 Bark app 指过去 —— 自建同样不需要 Apple 账号。
          </p>

          {msg && <p className="mt-2 text-[11px] text-muted-foreground">{msg}</p>}
        </div>
      </div>
    </section>
  );
}

// ── registered devices ──────────────────────────────────────────────────────

interface DeviceRow {
  id: string;
  platform: string;
  hint: string;
  barkServer: string | null;
  apnsEnv: string;
  createdAt: Date | string;
  lastSeenAt: Date | string;
}

function DeviceList({
  rows,
  loading,
  onChange,
}: {
  rows: DeviceRow[];
  loading: boolean;
  onChange: () => void;
}) {
  const [msg, setMsg] = useState<string | null>(null);
  const remove = trpc.push.remove.useMutation({ onSuccess: onChange });
  const test = trpc.push.test.useMutation({
    onSuccess: (r) =>
      setMsg(r.ok ? `已发往 ${r.devices} 台设备` : '还没有注册任何设备'),
    onError: (e) => setMsg(`失败：${e.message}`),
  });

  return (
    <section className="rounded-lg border border-border p-4">
      <div className="flex items-start gap-3">
        <BellRing className="h-5 w-5 shrink-0 text-foreground/70 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-foreground">
              已注册设备{rows.length > 0 && <span className="text-muted-foreground"> · {rows.length}</span>}
            </h3>
            <button
              type="button"
              disabled={rows.length === 0 || test.isPending}
              onClick={() => { setMsg(null); test.mutate(); }}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
              {test.isPending ? '发送中…' : '发条测试通知'}
            </button>
          </div>

          {loading ? (
            <p className="mt-3 text-xs text-muted-foreground">加载中…</p>
          ) : rows.length === 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">
              还没有设备。用上面任意一种方式注册一台。
            </p>
          ) : (
            <ul className="mt-3 flex flex-col gap-1.5">
              {rows.map((d) => (
                <li
                  key={d.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border px-2.5 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-xs text-foreground">
                      {PLATFORM_LABEL[d.platform] ?? d.platform}
                      <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">{d.hint}</span>
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {d.platform === 'bark' && d.barkServer ? `${d.barkServer} · ` : ''}
                      {d.platform === 'ios' ? `${d.apnsEnv} · ` : ''}
                      最后活跃 {relTime(d.lastSeenAt)}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label="移除这台设备"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate({ id: d.id })}
                    className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {msg && <p className="mt-2 text-[11px] text-muted-foreground">{msg}</p>}
          <p className="mt-3 text-[11px] text-muted-foreground leading-relaxed">
            测试通知走 <code className="rounded bg-muted px-1 py-0.5">host</code> 类型，会绕过 23:00–08:00 的静默时段 ——
            要等到早上才能收到的测试算不上测试。
          </p>
        </div>
      </div>
    </section>
  );
}

function Notice({ tone, text }: { tone: 'warn'; text: string }) {
  return (
    <div
      className={cn(
        'mt-3 flex items-start gap-2 rounded-md border px-2.5 py-2 text-[11px] leading-relaxed',
        tone === 'warn' && 'border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-400',
      )}
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
      <span>{text}</span>
    </div>
  );
}
