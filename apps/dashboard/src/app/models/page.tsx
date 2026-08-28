'use client';

// Settings → Models. Where this machine's model credentials live.
//
// This is the page Settings → Pi Runtime used to be, and the rename is the
// point: it was never a pi page. It held one endpoint, one key and one model
// list, and three harnesses wanted the same thing — so pi got a settings page
// with its name on it, dsh grew a two-valued `dshSource` enum to borrow it, and
// a third would have needed a third mechanism.
//
// Now it is a list. A credential is an endpoint plus the NAME of a secret plus
// the models it serves; Settings → Backends pairs one with a harness to make a
// backend. The two subscription backends appear at the top read-only, because
// they authenticate as themselves on the machine and there is nothing here to
// fill in for them.
//
// See docs/backends-and-models-design.md.

import { useState } from 'react';
import Link from 'next/link';
import { Loader2, Save, CheckCircle2, AlertTriangle, Eye, EyeOff, KeyRound, Trash2, Plus } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { SettingsTabs } from '@/components/settings-tabs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose,
} from '@/components/ui/dialog';
import {
  API_CHOICES, CREDENTIAL_PRESETS, DEFAULT_API, credentialFrom, formFromPreset,
  type CredentialForm, type ModelCredential,
} from '@/lib/model-credentials';

type ImageProvider = 'dashscope' | 'openrouter' | 'none';
type ImageConfig = {
  enabled?: boolean;
  provider?: ImageProvider;
  apiKeySecret?: string | null;
  ocrModel?: string;
  describeModel?: string;
  prompt?: string;
};

const IMAGE_DEFAULTS: Record<Exclude<ImageProvider, 'none'>, { ocr: string; describe: string; secret: string }> = {
  dashscope: { ocr: 'qwen-vl-ocr', describe: 'qwen-vl-max', secret: 'DASHSCOPE_API_KEY' },
  openrouter: { ocr: 'qwen/qwen2.5-vl-72b-instruct', describe: 'qwen/qwen2.5-vl-72b-instruct', secret: 'OPENROUTER_API_KEY' },
};

export default function ModelsSettingsPage() {
  const utils = trpc.useUtils();
  const credsQ = trpc.machines.getModelCredentials.useQuery();
  const piQ = trpc.machines.getPiConfig.useQuery();
  const subs = trpc.machines.subscriptionStatus.useQuery();
  const secrets = trpc.secrets.list.useQuery(undefined, { retry: false });

  // The form holds the EDITED list; null means "whatever the server says".
  // `stamp` is the server's answer as one string — when it moves (our save
  // landed, or another device edited the catalog) the local copy is replaced.
  // Adjusting state during render rather than in an effect is React's own
  // escape hatch for this, and the same shape the session detail sheet uses;
  // an effect here causes the cascading render the lint rule warns about.
  const [creds, setCreds] = useState<ModelCredential[] | null>(null);
  const [stamped, setStamped] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = trpc.machines.setModelCredentials.useMutation({
    onSuccess: () => {
      setErr(null);
      setSaved(true);
      void utils.machines.getModelCredentials.invalidate();
      // Backends render a credential's label; a rename has to reach them.
      void utils.machines.getBackendsConfig.invalidate();
      setTimeout(() => setSaved(false), 2500);
    },
    onError: (e) => setErr(e.message),
  });

  const stamp = credsQ.data ? JSON.stringify(credsQ.data) : null;
  if (stamp !== stamped) {
    setStamped(stamp);
    setCreds((credsQ.data as ModelCredential[] | undefined) ?? null);
  }

  const secretNames = secrets.data?.keys ?? [];
  const list = creds ?? [];

  function patch(id: string, p: Partial<ModelCredential>) {
    setCreds((cur) => (cur ?? []).map((c) => (c.id === id ? { ...c, ...p } : c)));
    setSaved(false);
  }

  function add(form: CredentialForm) {
    setCreds((cur) => {
      const next = cur ?? [];
      return [...next, credentialFrom(form, next.map((c) => c.id))];
    });
    setSaved(false);
    setAdding(false);
  }

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <SettingsTabs active="models" />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl p-4 sm:p-6 space-y-5">
          <p className="text-xs leading-relaxed text-muted-foreground">
            The model sources this machine can authenticate to. Each one is an endpoint plus the{' '}
            <span className="font-medium text-foreground/80">name</span> of a secret in this machine’s store — never
            the key itself. Pair one with a harness under{' '}
            <Link href="/backends" className="underline hover:text-foreground">Settings → Backends</Link>{' '}
            to make a backend you can start a chat on.
          </p>

          <SubscriptionCard
            claudeSeenAt={subs.data?.['claude-tmux']?.seenAt ?? null}
            codexSeenAt={subs.data?.['codex-exec']?.seenAt ?? null}
            codexPlan={subs.data?.['codex-exec']?.plan ?? null}
            loading={subs.isLoading}
          />

          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
              Model sources · credentials
            </h2>
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Add model source
            </Button>
          </div>

          {credsQ.isLoading ? (
            <div className="rounded-lg border border-border bg-card p-6 text-center text-xs text-muted-foreground">
              <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" /> loading…
            </div>
          ) : (
            list.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border p-4 text-xs leading-relaxed text-muted-foreground">
                None yet. Everything except the two subscriptions above needs one — a backend is a harness paired
                with a credential.
              </p>
            ) : list.map((c) => (
              <CredentialCard
                key={c.id}
                credential={c}
                secretNames={secretNames}
                onChange={(p) => patch(c.id, p)}
                onRemove={() => { setCreds((cur) => (cur ?? []).filter((x) => x.id !== c.id)); setSaved(false); }}
              />
            ))
          )}

          <div className="flex items-center gap-3">
            <Button onClick={() => save.mutate({ credentials: list })} disabled={save.isPending || creds === null}>
              {save.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
              Save
            </Button>
            {saved && (
              <span className="flex items-center gap-1 text-xs text-emerald-600">
                <CheckCircle2 className="h-3.5 w-3.5" /> Saved
              </span>
            )}
            {err && (
              <span className="flex items-start gap-1 text-xs text-rose-500">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {err}
              </span>
            )}
          </div>

          <VisionCard config={(piQ.data?.image ?? null) as ImageConfig | null} secretNames={secretNames} />
        </div>
      </div>

      {adding && (
        <CredentialDialog
          existingIds={list.map((c) => c.id)}
          secretNames={secretNames}
          onClose={() => setAdding(false)}
          onAdd={add}
        />
      )}
    </div>
  );
}

/** The two that authenticate as themselves. Read-only by construction. */
function SubscriptionCard({
  claudeSeenAt, codexSeenAt, codexPlan, loading,
}: {
  claudeSeenAt: Date | string | null;
  codexSeenAt: Date | string | null;
  codexPlan: string | null;
  loading: boolean;
}) {
  const rows = [
    {
      name: 'Claude Code subscription',
      seenAt: claudeSeenAt,
      detail: 'Interactive tmux sessions run on this one, and nothing else does.',
    },
    {
      name: 'Codex subscription',
      seenAt: codexSeenAt,
      detail: codexPlan ? `plan: ${codexPlan}` : '`codex login`, as this machine’s own user.',
    },
  ];
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Subscriptions · nothing to configure</h3>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/70">
        These two live on the machine, logged in and refreshed by their own CLIs, so there is no field here to
        fill in. No other harness <span className="text-foreground/80">can</span> be pointed at them either —
        running a Max account through a third-party harness is exactly what the rate limits and the request
        classifier exist to catch.
      </p>
      <div className="mt-3 divide-y divide-border rounded-md border border-border">
        {rows.map((r) => (
          <div key={r.name} className="flex items-center gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-foreground">{r.name}</div>
              <p className="mt-0.5 text-[11px] text-muted-foreground/70">{r.detail}</p>
            </div>
            <ActivationBadge seenAt={r.seenAt} loading={loading} />
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Activation, stated as what is actually known.
 *
 * "Seen" is a usage report from that CLI's collector, which only exists when it
 * is installed, authenticated and running. Never seen is reported as never
 * seen — not as "logged out", which would be a guess.
 */
function ActivationBadge({ seenAt, loading }: { seenAt: Date | string | null; loading: boolean }) {
  if (loading) return <span className="shrink-0 text-[11px] text-muted-foreground/60">…</span>;
  if (!seenAt) {
    return (
      <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
        no usage reported
      </span>
    );
  }
  const when = new Date(seenAt);
  const mins = Math.max(0, Math.round((Date.now() - when.getTime()) / 60_000));
  const ago = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return (
    <span className="shrink-0 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-400">
      active · {ago} ago
    </span>
  );
}

function CredentialCard({
  credential, secretNames, onChange, onRemove,
}: {
  credential: ModelCredential;
  secretNames: string[];
  onChange: (p: Partial<ModelCredential>) => void;
  onRemove: () => void;
}) {
  const [reveal, setReveal] = useState(false);
  const c = credential;
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Input
            value={c.label}
            onChange={(e) => onChange({ label: e.target.value })}
            className="h-8 max-w-[16rem] text-sm font-medium"
            aria-label="credential name"
          />
          <p className="mt-1 font-mono text-[10px] text-muted-foreground/60">id: {c.id}</p>
        </div>
        <button
          type="button"
          aria-label={`remove ${c.label}`}
          onClick={onRemove}
          className="rounded p-1 text-muted-foreground hover:text-rose-500 transition-colors"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Provider ID" hint="The provider name inside the harness — hyqubit / openrouter / zai.">
          <Input value={c.provider} onChange={(e) => onChange({ provider: e.target.value })}
            placeholder="hyqubit" className="h-9 font-mono" />
        </Field>
        <Field label="API type" hint="Which protocol the endpoint speaks.">
          <Select value={c.api} onValueChange={(v) => onChange({ api: v ?? DEFAULT_API })} modal={false}>
            <SelectTrigger className="h-9 font-mono" aria-label="api type">
              <SelectValue>{(v: string | null) => API_CHOICES.find((a) => a.value === v)?.label ?? v ?? DEFAULT_API}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {API_CHOICES.map((a) => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Base URL" hint="Blank means the harness brings its own endpoint (dsh’s DeepSeek catalog does).">
          <Input value={c.baseUrl} onChange={(e) => onChange({ baseUrl: e.target.value })}
            placeholder="https://litellm.hyqubit.com" className="h-9 font-mono" />
        </Field>
        <Field label="API Key" hint="The key’s NAME in the secrets store — never the key itself.">
          <div className="flex items-center gap-1.5">
            <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <Input
              type={reveal ? 'text' : 'password'}
              value={c.secretKey ?? ''}
              onChange={(e) => onChange({ secretKey: e.target.value })}
              placeholder="LITELLM_HYQUBIT_TOKEN"
              className="h-9 font-mono"
            />
            <button type="button" onClick={() => setReveal((v) => !v)}
              aria-label="toggle visibility" className="rounded p-1 text-muted-foreground hover:text-foreground transition-colors">
              {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
          <SecretPicker names={secretNames} onPick={(k) => onChange({ secretKey: k })} />
        </Field>
        <Field label="Model list" hint="Comma-separated. The model dropdown in session details reads this list.">
          <Input
            value={c.models.join(', ')}
            onChange={(e) => onChange({ models: e.target.value.split(',').map((m) => m.trim()).filter(Boolean) })}
            placeholder="claude-opus-5, claude-sonnet-5"
            className="h-9 font-mono"
          />
        </Field>
        <Field label="Default model" hint="Used when a backend on this credential names none of its own. Blank takes the first in the list.">
          <Input value={c.defaultModel ?? ''} onChange={(e) => onChange({ defaultModel: e.target.value })}
            placeholder={c.models[0] ?? 'first in the list'} className="h-9 font-mono" />
        </Field>
      </div>
    </section>
  );
}

/**
 * Compose a credential.
 *
 * Adds to the list on this page; the page's Save is what writes it to the
 * machine. That is deliberately the same as every other edit here — delete and
 * every field already work that way, and making ONLY add write immediately
 * would be the odd one out, and would commit half-finished edits sitting in
 * the cards above.
 */
function CredentialDialog({
  existingIds, secretNames, onClose, onAdd,
}: {
  existingIds: string[];
  secretNames: string[];
  onClose: () => void;
  onAdd: (form: CredentialForm) => void;
}) {
  const [presetKey, setPresetKey] = useState('hyqubit');
  const [form, setForm] = useState<CredentialForm>(() => formFromPreset('hyqubit'));
  const [reveal, setReveal] = useState(false);
  const set = (p: Partial<CredentialForm>) => setForm((cur) => ({ ...cur, ...p }));

  const preset = CREDENTIAL_PRESETS.find((p) => p.key === presetKey) ?? CREDENTIAL_PRESETS[0];
  // The provider id is the one field nothing can be inferred from, and an
  // endpoint with no provider cannot be registered with any harness.
  const ready = !!form.provider.trim();
  const preview = ready ? credentialFrom(form, existingIds) : null;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add model source</DialogTitle>
          <DialogDescription>
            An endpoint plus the <span className="font-medium text-foreground/80">name</span> of a secret in this
            machine’s store — never the key itself.
          </DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[55vh] grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Preset</span>
            {/* Fills the fields and nothing else — everything below stays editable,
                so a preset is a head start rather than a mode. */}
            <Select
              value={presetKey}
              onValueChange={(v) => { const k = v ?? 'custom'; setPresetKey(k); setForm(formFromPreset(k)); }}
              modal={false}
            >
              <SelectTrigger className="mt-1.5 h-9" aria-label="credential preset">
                <SelectValue>
                  {(v: string | null) => CREDENTIAL_PRESETS.find((p) => p.key === v)?.label ?? 'Custom'}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {CREDENTIAL_PRESETS.map((p) => <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <span className="mt-1 block text-[10px] leading-relaxed text-muted-foreground/70">{preset.hint}</span>
          </label>

          <Field label="Name" hint="What the picker and the backend list call it. Blank uses the Provider ID.">
            <Input value={form.label} onChange={(e) => set({ label: e.target.value })}
              placeholder={form.provider || 'hyqubit'} className="h-9" aria-label="credential name" />
          </Field>
          <Field label="Provider ID" hint="The provider name inside the harness — hyqubit / openrouter / zai.">
            <Input value={form.provider} onChange={(e) => set({ provider: e.target.value })}
              placeholder="hyqubit" className="h-9 font-mono" aria-label="provider id" />
          </Field>
          <Field label="API type" hint="Which protocol the endpoint speaks.">
            <Select value={form.api} onValueChange={(v) => set({ api: v ?? DEFAULT_API })} modal={false}>
              <SelectTrigger className="h-9 font-mono" aria-label="api type">
                <SelectValue>
                  {(v: string | null) => API_CHOICES.find((a) => a.value === v)?.label ?? v ?? DEFAULT_API}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {API_CHOICES.map((a) => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Base URL" hint="Blank means the harness brings its own endpoint (dsh’s DeepSeek catalog does).">
            <Input value={form.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })}
              placeholder="https://litellm.hyqubit.com" className="h-9 font-mono" aria-label="base url" />
          </Field>
          <Field label="API Key" hint="The key’s NAME in the secrets store — never the key itself.">
            <div className="flex items-center gap-1.5">
              <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <Input
                type={reveal ? 'text' : 'password'}
                value={form.secretKey}
                onChange={(e) => set({ secretKey: e.target.value })}
                placeholder="LITELLM_HYQUBIT_TOKEN"
                className="h-9 font-mono"
                aria-label="secret name"
              />
              <button type="button" onClick={() => setReveal((v) => !v)}
                aria-label="toggle visibility" className="rounded p-1 text-muted-foreground hover:text-foreground transition-colors">
                {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
            <SecretPicker names={secretNames} onPick={(k) => set({ secretKey: k })} />
          </Field>
          <Field label="Model list" hint="Comma-separated. The model dropdown in session details reads this list.">
            <Input value={form.models} onChange={(e) => set({ models: e.target.value })}
              placeholder="claude-opus-5, claude-sonnet-5" className="h-9 font-mono" aria-label="models" />
          </Field>
          <Field label="Default model" hint="Used when a backend on this credential names none of its own. Blank takes the first in the list.">
            <Input value={form.defaultModel} onChange={(e) => set({ defaultModel: e.target.value })}
              placeholder={preview?.models[0] ?? 'first in the list'} className="h-9 font-mono" aria-label="default model" />
          </Field>
        </div>

        <p className="text-[11px] leading-relaxed text-muted-foreground/70">
          {preview
            ? <>Saved as <span className="font-mono text-foreground/80">{preview.id}</span> — that id is what a backend references. Adding it puts it in the list below; Save at the bottom of the page writes it to this machine.</>
            : <>Provider ID is required: without one, no harness can register this endpoint.</>}
        </p>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button disabled={!ready} onClick={() => onAdd(form)}>Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The vision fallback: for endpoints that drop image blocks. Machine-wide. */
function VisionCard({ config, secretNames }: { config: ImageConfig | null; secretNames: string[] }) {
  const utils = trpc.useUtils();
  const [img, setImg] = useState<ImageConfig>({ enabled: false, provider: 'openrouter' });
  const [imgStamp, setImgStamp] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = trpc.machines.setVisionConfig.useMutation({
    onSuccess: () => {
      setSaved(true);
      void utils.machines.getPiConfig.invalidate();
      setTimeout(() => setSaved(false), 2500);
    },
  });
  // Same render-time adjustment as the credential list above.
  const stamp = config ? JSON.stringify(config) : null;
  if (stamp !== imgStamp) {
    setImgStamp(stamp);
    if (config) setImg((cur) => ({ ...cur, ...config }));
  }
  const provider = img.provider ?? 'openrouter';
  const defaults = provider === 'none' ? null : IMAGE_DEFAULTS[provider];

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Vision fallback</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/70">
            The two calls used when an endpoint drops image blocks — OCR, then a layout description. Nothing to
            do with any one credential: this is one setting for the whole machine.
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs">
          <input type="checkbox" checked={!!img.enabled}
            onChange={(e) => setImg({ ...img, enabled: e.target.checked })} aria-label="enable vision fallback" />
          Enable
        </label>
      </div>
      {img.enabled && (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 animate-in fade-in-0">
          <Field label="Vision provider">
            <Select value={provider} onValueChange={(v) => setImg({ ...img, provider: (v ?? 'openrouter') as ImageProvider })} modal={false}>
              <SelectTrigger className="h-9" aria-label="vision provider">
                <SelectValue>{(v: string | null) => v ?? 'openrouter'}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openrouter">openrouter</SelectItem>
                <SelectItem value="dashscope">dashscope</SelectItem>
                <SelectItem value="none">none</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="API Key" hint="A key name again. Both calls share this one.">
            <Input value={img.apiKeySecret ?? ''} onChange={(e) => setImg({ ...img, apiKeySecret: e.target.value })}
              placeholder={defaults?.secret ?? 'OPENROUTER_API_KEY'} className="h-9 font-mono" />
            <SecretPicker names={secretNames} onPick={(k) => setImg({ ...img, apiKeySecret: k })} />
          </Field>
          {defaults && (
            <>
              <Field label="OCR model" hint="Pulls the text out line by line. Blank uses the default.">
                <Input value={img.ocrModel ?? ''} onChange={(e) => setImg({ ...img, ocrModel: e.target.value })}
                  placeholder={defaults.ocr} className="h-9 font-mono" />
              </Field>
              <Field label="Layout model" hint="Describes how the screen is put together. Blank uses the default.">
                <Input value={img.describeModel ?? ''} onChange={(e) => setImg({ ...img, describeModel: e.target.value })}
                  placeholder={defaults.describe} className="h-9 font-mono" />
              </Field>
            </>
          )}
        </div>
      )}
      <div className="mt-4 flex items-center gap-3">
        <Button size="sm" variant="outline" onClick={() => save.mutate({ image: img })} disabled={save.isPending}>
          {save.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}Save
        </Button>
        {saved && <span className="text-xs text-emerald-600">Saved</span>}
      </div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint && <span className="mt-1 block text-[10px] leading-relaxed text-muted-foreground/70">{hint}</span>}
    </label>
  );
}

/** Secret names from this machine's store — click to fill, so nobody types one wrong. */
function SecretPicker({ names, onPick }: { names: string[]; onPick: (k: string) => void }) {
  if (names.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {names.slice(0, 12).map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => onPick(k)}
          className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {k}
        </button>
      ))}
      {names.length > 12 && <span className="self-center text-[10px] text-muted-foreground/60">+{names.length - 12} more…</span>}
    </div>
  );
}
