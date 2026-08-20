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
  API_CHOICES, CREDENTIAL_PRESETS, DEFAULT_API, uniqueCredentialId,
  type ModelCredential,
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

  function add(presetKey: string) {
    const preset = CREDENTIAL_PRESETS.find((p) => p.key === presetKey) ?? CREDENTIAL_PRESETS[0];
    const label = preset.fill.label ?? 'New endpoint';
    setCreds((cur) => {
      const next = cur ?? [];
      return [...next, {
        id: uniqueCredentialId(label, next.map((c) => c.id)),
        label,
        provider: preset.fill.provider ?? '',
        api: preset.fill.api ?? DEFAULT_API,
        baseUrl: preset.fill.baseUrl ?? '',
        models: preset.fill.models ?? [],
        secretKey: preset.fill.secretKey ?? '',
      }];
    });
    setSaved(false);
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

          {credsQ.isLoading ? (
            <div className="rounded-lg border border-border bg-card p-6 text-center text-xs text-muted-foreground">
              <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" /> loading…
            </div>
          ) : (
            list.map((c) => (
              <CredentialCard
                key={c.id}
                credential={c}
                secretNames={secretNames}
                onChange={(p) => patch(c.id, p)}
                onRemove={() => { setCreds((cur) => (cur ?? []).filter((x) => x.id !== c.id)); setSaved(false); }}
              />
            ))
          )}

          <AddCredential onAdd={add} />

          <div className="flex items-center gap-3">
            <Button onClick={() => save.mutate({ credentials: list })} disabled={save.isPending || creds === null}>
              {save.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
              保存
            </Button>
            {saved && (
              <span className="flex items-center gap-1 text-xs text-emerald-600">
                <CheckCircle2 className="h-3.5 w-3.5" /> 已保存
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
      name: 'Claude Code 订阅',
      seenAt: claudeSeenAt,
      detail: 'Interactive tmux 会话走这一份，也是唯一走它的东西。',
    },
    {
      name: 'Codex 订阅',
      seenAt: codexSeenAt,
      detail: codexPlan ? `plan: ${codexPlan}` : '`codex login`，与本机同一个用户。',
    },
  ];
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">订阅 · 无需配置</h3>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/70">
        这两份凭据在机器上，由各自的 CLI 自己登录和刷新，这里没有可填的字段。其他 harness 也<span className="text-foreground/80">不能</span>指向它们
        —— 拿第三方 harness 去跑一个 Max 账号，正是限流和请求分类器存在的理由。
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
        未见用量上报
      </span>
    );
  }
  const when = new Date(seenAt);
  const mins = Math.max(0, Math.round((Date.now() - when.getTime()) / 60_000));
  const ago = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return (
    <span className="shrink-0 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-400">
      已激活 · {ago} 前
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
          className="rounded p-1 text-muted-foreground hover:text-rose-500"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Provider ID" hint="harness 里的 provider 名，例如 hyqubit / openrouter / zai">
          <Input value={c.provider} onChange={(e) => onChange({ provider: e.target.value })}
            placeholder="hyqubit" className="h-9 font-mono" />
        </Field>
        <Field label="API 类型" hint="端点说的是哪套协议">
          <Select value={c.api} onValueChange={(v) => onChange({ api: v ?? DEFAULT_API })} modal={false}>
            <SelectTrigger className="h-9 font-mono" aria-label="api type">
              <SelectValue>{(v: string | null) => API_CHOICES.find((a) => a.value === v)?.label ?? v ?? DEFAULT_API}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {API_CHOICES.map((a) => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Base URL" hint="留空表示这套 harness 自带端点（dsh 的 DeepSeek 目录就是这样）">
          <Input value={c.baseUrl} onChange={(e) => onChange({ baseUrl: e.target.value })}
            placeholder="https://litellm.hyqubit.com" className="h-9 font-mono" />
        </Field>
        <Field label="API Key" hint="填 secrets store 里的 key 名，不是 key 本身">
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
              aria-label="toggle visibility" className="rounded p-1 text-muted-foreground hover:text-foreground">
              {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
          <SecretPicker names={secretNames} onPick={(k) => onChange({ secretKey: k })} />
        </Field>
        <Field label="模型列表" hint="逗号分隔；会话详情里的模型下拉读的就是这个列表">
          <Input
            value={c.models.join(', ')}
            onChange={(e) => onChange({ models: e.target.value.split(',').map((m) => m.trim()).filter(Boolean) })}
            placeholder="claude-opus-5, claude-sonnet-5"
            className="h-9 font-mono"
          />
        </Field>
        <Field label="默认模型" hint="用这个凭据的 backend 不另外指定时用它。留空取列表第一个。">
          <Input value={c.defaultModel ?? ''} onChange={(e) => onChange({ defaultModel: e.target.value })}
            placeholder={c.models[0] ?? '列表第一个'} className="h-9 font-mono" />
        </Field>
      </div>
    </section>
  );
}

function AddCredential({ onAdd }: { onAdd: (presetKey: string) => void }) {
  const [key, setKey] = useState('hyqubit');
  const preset = CREDENTIAL_PRESETS.find((p) => p.key === key) ?? CREDENTIAL_PRESETS[0];
  return (
    <section className="rounded-lg border border-dashed border-border p-4">
      <h3 className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">添加模型来源</h3>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem] flex-1">
          <Select value={key} onValueChange={(v) => setKey(v ?? 'hyqubit')} modal={false}>
            <SelectTrigger className="h-9" aria-label="credential preset">
              <SelectValue>{(v: string | null) => CREDENTIAL_PRESETS.find((p) => p.key === v)?.label ?? '自定义'}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {CREDENTIAL_PRESETS.map((p) => <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button size="sm" onClick={() => onAdd(key)}>
          <Plus className="mr-1 h-3.5 w-3.5" /> 添加
        </Button>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/70">{preset.hint}</p>
    </section>
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
          <h3 className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">图片识别兜底</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/70">
            端点丢掉图片块时用的两次调用（OCR + 布局描述）。跟凭据无关，是整台机器一份。
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs">
          <input type="checkbox" checked={!!img.enabled}
            onChange={(e) => setImg({ ...img, enabled: e.target.checked })} aria-label="enable vision fallback" />
          启用
        </label>
      </div>
      {img.enabled && (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="识别 Provider">
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
          <Field label="API Key" hint="同样填 key 名。两次调用共用这一个">
            <Input value={img.apiKeySecret ?? ''} onChange={(e) => setImg({ ...img, apiKeySecret: e.target.value })}
              placeholder={defaults?.secret ?? 'OPENROUTER_API_KEY'} className="h-9 font-mono" />
            <SecretPicker names={secretNames} onPick={(k) => setImg({ ...img, apiKeySecret: k })} />
          </Field>
          {defaults && (
            <>
              <Field label="OCR 模型" hint="逐行提取文字。留空用默认">
                <Input value={img.ocrModel ?? ''} onChange={(e) => setImg({ ...img, ocrModel: e.target.value })}
                  placeholder={defaults.ocr} className="h-9 font-mono" />
              </Field>
              <Field label="布局描述模型" hint="描述界面结构。留空用默认">
                <Input value={img.describeModel ?? ''} onChange={(e) => setImg({ ...img, describeModel: e.target.value })}
                  placeholder={defaults.describe} className="h-9 font-mono" />
              </Field>
            </>
          )}
        </div>
      )}
      <div className="mt-4 flex items-center gap-3">
        <Button size="sm" variant="outline" onClick={() => save.mutate({ image: img })} disabled={save.isPending}>
          {save.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}保存
        </Button>
        {saved && <span className="text-xs text-emerald-600">已保存</span>}
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
