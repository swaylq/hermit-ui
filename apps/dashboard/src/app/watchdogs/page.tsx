'use client';

// Settings → Watchdogs: every watchdog that guards this machine, what it is
// set to, and what it last did — in one place, editable in one place.
//
// Six watchdogs in three habitats, all reading the same Machine.watchdogConfig:
// the two dashboard sweeps and the host red-zone apply a saved value within a
// minute; the gateway ticks and the launchd watchdog pick it up at the next
// gateway restart (restarts are batched, 2026-08-26) — the page says so on
// those cards rather than letting a saved number pretend it is live.

import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { SettingsTabs } from '@/components/settings-tabs';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DEFAULT_WATCHDOG_CONFIG, type WatchdogConfig } from '@/lib/watchdog-config';

type AlertInfo = {
  message: string;
  createdAt: string | Date;
  resolvedAt: string | Date | null;
  expiresAt: string | Date | null;
} | undefined;

function isOpen(a: NonNullable<AlertInfo>): boolean {
  if (a.resolvedAt) return false;
  if (!a.expiresAt) return true;
  const t = typeof a.expiresAt === 'string' ? new Date(a.expiresAt) : a.expiresAt;
  return t.getTime() > Date.now();
}

function fmtWhen(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const t = typeof d === 'string' ? new Date(d) : d;
  const mins = Math.round((Date.now() - t.getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function LastAlert({ alert }: { alert: AlertInfo }) {
  if (!alert) return <p className="text-xs text-muted-foreground">No alerts raised yet.</p>;
  return (
    <p className="text-xs text-muted-foreground">
      Last alert {fmtWhen(alert.createdAt)}
      {isOpen(alert) ? ' (still open)' : alert.resolvedAt ? ` (cleared ${fmtWhen(alert.resolvedAt)})` : ' (lapsed)'}: {alert.message}
    </p>
  );
}

function Enabled({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="h-4 w-4 accent-foreground"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      Enabled
    </label>
  );
}

function Num({
  label,
  value,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="w-40 shrink-0 text-muted-foreground">{label}</span>
      <Input
        type="number"
        className="h-8 w-28"
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
      {unit ? <span className="text-xs text-muted-foreground">{unit}</span> : null}
    </label>
  );
}

function WatchdogCard({
  title,
  habitat,
  blurb,
  delayed,
  children,
}: {
  title: string;
  habitat: string;
  blurb: string;
  /** True when a saved value only goes live at the next gateway restart. */
  delayed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className="space-y-3 p-4">
      <div>
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-xs text-muted-foreground">{habitat}</div>
      </div>
      <p className="text-sm text-muted-foreground">{blurb}</p>
      <div className="space-y-2">{children}</div>
      {delayed ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Saved values go live at this machine&apos;s next gateway restart (restarts are batched, once a day).
        </p>
      ) : null}
    </Card>
  );
}

export default function WatchdogsPage() {
  const utils = trpc.useUtils();
  const status = trpc.watchdogs.status.useQuery(undefined, { refetchInterval: 15_000 }).data;
  const [draft, setDraft] = useState<WatchdogConfig | null>(null);
  useEffect(() => {
    if (status && !draft) setDraft(status.config as WatchdogConfig);
  }, [status, draft]);

  const save = trpc.machines.setWatchdogConfig.useMutation({
    onSuccess: () => utils.watchdogs.status.invalidate(),
  });

  if (!status || !draft) {
    return (
      <div className="flex flex-1 flex-col min-h-0">
        <SettingsTabs active="watchdogs" />
        <div className="p-6 text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(status.config);
  const set = <K extends keyof WatchdogConfig>(k: K, v: WatchdogConfig[K]) =>
    setDraft({ ...draft, [k]: v });
  const alerts = status.lastAlertByKind as Record<string, AlertInfo>;

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <SettingsTabs active="watchdogs" />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl p-4 sm:p-6 space-y-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Every watchdog guarding this machine, its settings, and what it last did.
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={save.isPending}
                onClick={() => setDraft(structuredClone(DEFAULT_WATCHDOG_CONFIG))}
              >
                Defaults
              </Button>
              <Button
                size="sm"
                disabled={!dirty || save.isPending}
                onClick={() => save.mutate({ config: draft })}
              >
                {save.isPending ? 'Saving…' : dirty ? 'Save' : 'Saved'}
              </Button>
            </div>
          </div>
          {save.error ? <p className="text-sm text-destructive">{save.error.message}</p> : null}

          <WatchdogCard
            title="Stuck messages"
            habitat="dashboard sweep · every 1 min"
            blurb="Alerts when a message you sent is still waiting for the gateway after this long and its session is not provably busy — the exact &quot;messages not going out&quot; signal."
          >
            <Enabled checked={draft.stuck.enabled} onChange={(v) => set('stuck', { ...draft.stuck, enabled: v })} />
            <Num label="Stuck after" value={draft.stuck.minutes} unit="min" onChange={(v) => set('stuck', { ...draft.stuck, minutes: v })} />
            <p className="text-xs text-muted-foreground">
              {status.stuckOpenCount > 0
                ? `${status.stuckOpenCount} alert(s) open right now — messages are not draining.`
                : 'Nothing stuck right now.'}
            </p>
            <LastAlert alert={alerts['stuck-messages']} />
          </WatchdogCard>

          <WatchdogCard
            title="Unanswered messages"
            habitat="dashboard sweep · every 5 min"
            blurb="Alerts when the newest word in a conversation is yours and nobody has replied — the &quot;a live session swallowed my question&quot; signal."
          >
            <Enabled checked={draft.unanswered.enabled} onChange={(v) => set('unanswered', { ...draft.unanswered, enabled: v })} />
            <Num label="Unanswered after" value={draft.unanswered.minutes} unit="min" onChange={(v) => set('unanswered', { ...draft.unanswered, minutes: v })} />
            <p className="text-xs text-muted-foreground">
              {status.unansweredFlagged > 0
                ? `${status.unansweredFlagged} conversation(s) currently owe you a reply past the threshold.`
                : 'No conversation currently owes you a reply past the threshold.'}
            </p>
          </WatchdogCard>

          <WatchdogCard
            title="Host red-zone"
            habitat="gateway reports every 30s · dashboard judges on crossing"
            blurb="Pushes when free RAM or load crosses red — the &quot;this box is being strangled&quot; signal."
          >
            <Enabled checked={draft.hostRed.enabled} onChange={(v) => set('hostRed', { ...draft.hostRed, enabled: v })} />
            <Num label="Red: free RAM below" value={draft.hostRed.redFreeMb} unit="MB" onChange={(v) => set('hostRed', { ...draft.hostRed, redFreeMb: v })} />
            <Num label="Amber: free RAM below" value={draft.hostRed.amberFreeMb} unit="MB" onChange={(v) => set('hostRed', { ...draft.hostRed, amberFreeMb: v })} />
            <Num label="Red: load over" value={draft.hostRed.redLoadFactor} unit="× cpu count" onChange={(v) => set('hostRed', { ...draft.hostRed, redLoadFactor: v })} />
            <Num label="Amber: load over" value={draft.hostRed.amberLoadFactor} unit="× cpu count" onChange={(v) => set('hostRed', { ...draft.hostRed, amberLoadFactor: v })} />
            <p className="text-xs text-muted-foreground">
              Now: {status.host.health ?? 'no data yet'}
              {status.host.sampledAt ? ` (sampled ${fmtWhen(status.host.sampledAt)})` : ''}
              {status.host.redAlertAt ? ` · red since ${fmtWhen(status.host.redAlertAt)}` : ''}.
            </p>
          </WatchdogCard>

          <WatchdogCard
            title="Stray browser reaper"
            habitat="gateway tick · every 5 min"
            blurb="Kills headless browsers nobody owns — a leaking script's own watchdog cannot be trusted, so the bound lives here (2026-08-26, 391 leaked browsers took a machine to load 237)."
            delayed
          >
            <Enabled checked={draft.strayReaper.enabled} onChange={(v) => set('strayReaper', { ...draft.strayReaper, enabled: v })} />
            <Num label="Kill roots older than" value={draft.strayReaper.ageMinutes} unit="min" onChange={(v) => set('strayReaper', { ...draft.strayReaper, ageMinutes: v })} />
            <Num label="Max root browsers" value={draft.strayReaper.maxRoots} onChange={(v) => set('strayReaper', { ...draft.strayReaper, maxRoots: v })} />
            <LastAlert alert={alerts['chrome-leak']} />
          </WatchdogCard>

          <WatchdogCard
            title="Idle Chrome reaper"
            habitat="gateway tick · every 5 min"
            blurb="Stops an agent&apos;s own Chrome once it has been idle without a browser task — each one is ~1GB the session reaper leaves behind."
            delayed
          >
            <Enabled checked={draft.chromeReaper.enabled} onChange={(v) => set('chromeReaper', { ...draft.chromeReaper, enabled: v })} />
            <Num label="Idle grace" value={draft.chromeReaper.idleMinutes} unit="min" onChange={(v) => set('chromeReaper', { ...draft.chromeReaper, idleMinutes: v })} />
          </WatchdogCard>

          <WatchdogCard
            title="Gateway watchdog"
            habitat="launchd · hourly · lives fully outside pm2 and the gateway"
            blurb="Restarts a gateway that fell out of pm2, restarts one that is triple-confirmed wedged (3h cooldown), and alerts on starvation: load over the ceiling or the gateway log silent. Off switch: the gateway-watch.off file on the machine."
            delayed
          >
            <Num label="Load alert ceiling" value={draft.gatewayWatch.loadMax} onChange={(v) => set('gatewayWatch', { ...draft.gatewayWatch, loadMax: v })} />
            <Num label="Log silence alert" value={draft.gatewayWatch.silentSec} unit="sec" onChange={(v) => set('gatewayWatch', { ...draft.gatewayWatch, silentSec: v })} />
            <Num label="Wedge: failures in a row" value={draft.gatewayWatch.wedgeFails} onChange={(v) => set('gatewayWatch', { ...draft.gatewayWatch, wedgeFails: v })} />
            <Num label="Wedge: confirm window" value={draft.gatewayWatch.confirmSec} unit="sec" onChange={(v) => set('gatewayWatch', { ...draft.gatewayWatch, confirmSec: v })} />
            <Num label="Wedge: cooldown" value={draft.gatewayWatch.cooldownSec} unit="sec" onChange={(v) => set('gatewayWatch', { ...draft.gatewayWatch, cooldownSec: v })} />
            <LastAlert alert={alerts['gateway-wedged'] ?? alerts['high-load'] ?? alerts['gateway-resurrected'] ?? alerts['gateway-start-failed']} />
          </WatchdogCard>
        </div>
      </div>
    </div>
  );
}
