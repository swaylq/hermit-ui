'use client';

// Settings → Backends. What the currently selected machine can start a chat on.
//
// Two built-in backends ship enabled and cannot be edited: Claude Code and
// Codex each authenticate as themselves against their own subscription, so
// there is nothing to configure and nothing to choose. Everything else the user
// COMPOSES here — one harness (pi, Prime Agent, DeepSeek Harness) paired with
// one credential from Settings → Models. A machine that has composed none
// offers exactly the two, which is the intended resting state.
//
// See docs/backends-and-models-design.md.

import { useState } from 'react';
import Link from 'next/link';
import { Trash2, Plus } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { SettingsTabs } from '@/components/settings-tabs';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import {
  BUILT_IN_BACKENDS, instancesOf, isBackendEnabled, toggleBackend,
  addBackendInstance, removeBackendInstance, uniqueBackendId,
  type BackendInstance, type BackendsConfig,
} from '@/lib/backends';
import { CUSTOM_HARNESSES, RUNTIME_BLURB, RUNTIME_NEEDS, runtimeLabel, type CustomHarness } from '@/lib/runtime-labels';
import { PI_MODE_CHOICES, PI_MODE_META, DEFAULT_PI_MODE, isPiMode } from '@/lib/pi-modes';

export default function BackendsPage() {
  const utils = trpc.useUtils();
  const confirm = useConfirm();
  const cfg = trpc.machines.getBackendsConfig.useQuery();
  const creds = trpc.machines.getModelCredentials.useQuery();
  const [err, setErr] = useState<string | null>(null);
  const save = trpc.machines.setBackendsConfig.useMutation({
    onSuccess: () => {
      // The pickers read the same query, so invalidating here is what makes a
      // change show up in an already-open new-chat screen.
      void utils.machines.getBackendsConfig.invalidate();
      setErr(null);
    },
    onError: (e) => setErr(e.message),
  });

  const busy = save.isPending || cfg.isPending;
  const instances = instancesOf(cfg.data);
  const credentials = creds.data ?? [];

  function commit(next: BackendsConfig | null) {
    if (!next) {
      setErr('At least one backend has to stay enabled — otherwise there is nothing to start a chat on.');
      return;
    }
    setErr(null);
    save.mutate({ config: next });
  }

  async function onRemove(i: BackendInstance) {
    const ok = await confirm({
      title: `Remove ${i.label}?`,
      message: (
        <>
          Sessions and agents pointed at it fall back to Claude Code on their next turn.
          Nothing already running is stopped, and the credential itself is left alone.
        </>
      ),
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    commit(removeBackendInstance(cfg.data, i.id));
  }

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <SettingsTabs active="backends" />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl p-4 sm:p-6 space-y-6">
          <p className="text-xs text-muted-foreground">
            What the <span className="font-medium text-foreground/80">currently selected machine</span> can start a
            chat on. Switching one off hides it from the new-chat picker and from an agent’s default — it does not
            stop a session already running on it, and that session keeps showing its own backend so the picker never
            misrepresents what is running.
          </p>

          {cfg.isLoading ? (
            <div className="space-y-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
          ) : (
            <>
              <section>
                <h2 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">订阅 · built in</h2>
                <Card className="divide-y divide-border p-0">
                  {BUILT_IN_BACKENDS.map((b) => (
                    <BackendRow
                      key={b.id}
                      title={b.label}
                      blurb={b.blurb}
                      needs={RUNTIME_NEEDS[b.harness]}
                      on={isBackendEnabled(b.id, cfg.data)}
                      busy={busy}
                      onToggle={(on) => commit(toggleBackend(cfg.data, b.id, on))}
                    />
                  ))}
                </Card>
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground/70">
                  These two run on this machine’s own subscription. They take no credential and cannot be pointed at
                  one — and neither can the harnesses below be pointed at <em>them</em>.
                </p>
              </section>

              <section>
                <h2 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                  自建 · harness + credential
                </h2>
                {instances.length === 0 ? (
                  <Card className="p-4">
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      None yet. Pair a harness with one of your credentials below and it appears in the new-chat
                      picker and in every agent’s default-backend list.
                    </p>
                  </Card>
                ) : (
                  <Card className="divide-y divide-border p-0">
                    {instances.map((i) => (
                      <BackendRow
                        key={i.id}
                        title={i.label}
                        subtitle={[
                          runtimeLabel(i.harness),
                          credentials.find((c) => c.id === i.credentialId)?.label ?? `${i.credentialId} (missing)`,
                          i.model || null,
                          i.harness === 'pi-rpc' ? (i.mode ?? DEFAULT_PI_MODE) : null,
                        ].filter(Boolean).join(' · ')}
                        blurb={RUNTIME_BLURB[i.harness]}
                        needs={RUNTIME_NEEDS[i.harness]}
                        on={isBackendEnabled(i.id, cfg.data)}
                        busy={busy}
                        onToggle={(on) => commit(toggleBackend(cfg.data, i.id, on))}
                        onRemove={() => onRemove(i)}
                      />
                    ))}
                  </Card>
                )}
              </section>

              <AddBackend
                config={cfg.data}
                credentials={credentials}
                busy={busy}
                onAdd={(instance) => commit(addBackendInstance(cfg.data, instance))}
              />
            </>
          )}

          {err && <p className="text-xs text-rose-500">{err}</p>}
        </div>
      </div>
    </div>
  );
}

function BackendRow({
  title, subtitle, blurb, needs, on, busy, onToggle, onRemove,
}: {
  title: string; subtitle?: string; blurb: string; needs: string;
  on: boolean; busy: boolean;
  onToggle: (on: boolean) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="flex items-start gap-3 p-3 sm:p-4">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {subtitle && <p className="mt-0.5 font-mono text-[11px] text-muted-foreground/80 break-all">{subtitle}</p>}
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{blurb}</p>
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground/70">{needs}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        {onRemove && (
          <button
            type="button"
            aria-label={`remove ${title}`}
            disabled={busy}
            onClick={onRemove}
            className="rounded p-1 text-muted-foreground hover:text-rose-500 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
        {/* Same switch markup as Global Memory's — there is no shared ui/switch
            in this app, and inventing a second toggle style for one page is how
            two of them drift. */}
        <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
          <span className={on ? 'font-medium text-emerald-600' : 'text-muted-foreground'}>{on ? 'On' : 'Off'}</span>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={`${title} enabled`}
            disabled={busy}
            onClick={() => onToggle(!on)}
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
              on ? 'bg-emerald-500' : 'bg-muted-foreground/30',
            )}
          >
            <span className={cn(
              'inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
              on ? 'translate-x-4' : 'translate-x-0.5',
            )} />
          </button>
        </label>
      </div>
    </div>
  );
}

/** The composer: one harness, one credential, and the two optional dials. */
function AddBackend({
  config, credentials, busy, onAdd,
}: {
  config: BackendsConfig | null | undefined;
  credentials: { id: string; label: string; models: string[] }[];
  busy: boolean;
  onAdd: (i: BackendInstance) => void;
}) {
  const [harness, setHarness] = useState<CustomHarness>('pi-rpc');
  const [credentialId, setCredentialId] = useState('');
  const [label, setLabel] = useState('');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState<string>(DEFAULT_PI_MODE);

  const credential = credentials.find((c) => c.id === credentialId);
  // Suggested, not forced: "pi · hyqubit" is what almost everyone wants, and
  // the field stays editable for the machine that ends up with two.
  const suggested = credential ? `${runtimeLabel(harness)} · ${credential.label}` : '';
  const effectiveLabel = label.trim() || suggested;
  const ready = !!credential && !!effectiveLabel;

  if (credentials.length === 0) {
    return (
      <Card className="p-4">
        <h2 className="text-sm font-medium text-foreground">Add a backend</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          A backend is a harness plus a credential, and there are no credentials on this machine yet. Add an endpoint
          and its API key under{' '}
          <Link href="/models" className="underline hover:text-foreground">Settings → Models</Link> first.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-4 space-y-3">
      <div>
        <h2 className="text-sm font-medium text-foreground">Add a backend</h2>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
          One harness, one credential. The same harness can appear more than once against different credentials —
          that is the point.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Harness</span>
          <Select value={harness} onValueChange={(v) => setHarness(v as CustomHarness)} modal={false}>
            <SelectTrigger aria-label="harness" className="mt-1.5 w-full py-2 text-sm">
              <SelectValue>{(v: string | null) => runtimeLabel(v ?? harness)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {CUSTOM_HARNESSES.map((h) => <SelectItem key={h} value={h}>{runtimeLabel(h)}</SelectItem>)}
            </SelectContent>
          </Select>
          <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">{RUNTIME_BLURB[harness]}</span>
        </label>

        <label className="block">
          <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Credential</span>
          <Select value={credentialId} onValueChange={(v) => setCredentialId(v ?? '')} modal={false}>
            <SelectTrigger aria-label="credential" className="mt-1.5 w-full py-2 text-sm">
              <SelectValue placeholder="pick one">
                {(v: string | null) => credentials.find((c) => c.id === v)?.label ?? 'pick one'}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {credentials.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
            Endpoint and key from <Link href="/models" className="underline hover:text-foreground">Settings → Models</Link>.
          </span>
        </label>

        <label className="block">
          <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Name</span>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={suggested || 'pi · hyqubit'}
            className="mt-1.5 h-9 font-mono"
            aria-label="backend name"
          />
          <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
            What the picker calls it. Blank uses the suggestion.
          </span>
        </label>

        <label className="block">
          <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">默认模型</span>
          <Input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={credential?.models[0] ?? '留空用凭证的默认'}
            className="mt-1.5 h-9 font-mono"
            aria-label="default model"
          />
          <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
            Optional. Blank falls through to the credential’s own default.
          </span>
        </label>

        {harness === 'pi-rpc' && (
          <label className="block sm:col-span-2">
            <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Mode</span>
            <Select value={mode} onValueChange={(v) => setMode(isPiMode(v) ? v : DEFAULT_PI_MODE)} modal={false}>
              <SelectTrigger aria-label="pi mode" className="mt-1.5 w-full py-2 text-sm">
                <SelectValue>{(v: string | null) => PI_MODE_META[isPiMode(v) ? v : DEFAULT_PI_MODE].label}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {PI_MODE_CHOICES.map((m) => <SelectItem key={m} value={m}>{PI_MODE_META[m].label}</SelectItem>)}
              </SelectContent>
            </Select>
            <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
              {PI_MODE_META[isPiMode(mode) ? mode : DEFAULT_PI_MODE].blurb}
            </span>
          </label>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={!ready || busy}
          onClick={() => {
            if (!credential) return;
            onAdd({
              id: uniqueBackendId(harness, credential.id, config),
              harness,
              credentialId: credential.id,
              label: effectiveLabel,
              ...(model.trim() ? { model: model.trim() } : {}),
              // Only pi has modes, and only a mode that differs from the fleet
              // default is worth storing — see lib/pi-modes.
              ...(harness === 'pi-rpc' && mode !== DEFAULT_PI_MODE ? { mode } : {}),
            });
            setLabel('');
            setModel('');
          }}
        >
          <Plus className="mr-1 h-3.5 w-3.5" /> Add backend
        </Button>
        <span className="text-[11px] text-muted-foreground">{RUNTIME_NEEDS[harness]}</span>
      </div>
    </Card>
  );
}
