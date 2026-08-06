'use client';

// Settings → Pi Runtime: this machine's model endpoint for pi agents, plus the
// vision fallback used when that endpoint drops image blocks.
//
// Layout and controls follow the other settings pages (header bar outside the
// padding, its own scroll container, max-w-3xl column, uppercase micro-labels,
// the shared Select). This page used to carry its own dialect: p-6 wrapped
// around the header bar so it sat indented, full-bleed width on a desktop,
// ui/label — used by no other page — and raw <select> elements.

import { useState, useEffect } from 'react';
import { Loader2, Save, CheckCircle2, AlertTriangle, Eye, EyeOff, KeyRound } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { SettingsTabs } from '@/components/settings-tabs';

type ImageProvider = 'dashscope' | 'openrouter' | 'none';

type PiConfig = {
  authMode?: 'api-key' | 'cc-subscription';
  provider?: string;
  baseUrl?: string;
  api?: string;
  models?: string[];
  defaultModel?: string;
  secretKey?: string | null;
  image?: {
    enabled?: boolean;
    provider?: ImageProvider;
    apiKeySecret?: string | null;
    ocrModel?: string;
    describeModel?: string;
    prompt?: string;
  };
};

const EMPTY: PiConfig = {
  authMode: 'api-key',
  provider: '',
  baseUrl: '',
  api: 'anthropic-messages',
  models: [],
  defaultModel: '',
  secretKey: '',
  image: { enabled: false, provider: 'openrouter', apiKeySecret: '', ocrModel: '', describeModel: '', prompt: '' },
};

// One-click endpoint presets for the machine provider. Kimi goes through pi's
// BUILT-IN moonshotai-cn provider (tuned catalog: 1M context for kimi-k3,
// native vision, kimi deferred tools) — the gateway maps provider moonshotai-cn
// to the MOONSHOT_API_KEY secret and skips custom registration for it. baseUrl
// is informational for built-in providers; the extension ignores it.
//
// 'cc-subscription' 复用本机 Claude Code 的 Keychain OAuth 凭据（订阅），不需要
// API key：gateway 注入 ANTHROPIC_AUTH_TOKEN，anthropic 走 pi 内置 provider。
type ProviderPreset = { provider: string; baseUrl: string; api: string; models: string[]; defaultModel: string; secretKey: string };
const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  custom: { provider: '', baseUrl: '', api: 'anthropic-messages', models: [], defaultModel: '', secretKey: '' },
  // Claude Code 订阅（复用本机 Keychain OAuth，无 API key；走订阅计划额度）
  // Model ids verified against the subscription endpoint (2026-08-06): each
  // returns 200 with `anthropic-ratelimit-unified-status: allowed`, i.e. drawing
  // on the plan rather than extra usage. The 4-8/4-6 generation this listed
  // before also still works — it was simply a generation behind.
  'cc-subscription': {
    provider: 'anthropic',
    baseUrl: '',
    api: 'anthropic-messages',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    defaultModel: 'claude-opus-5',
    secretKey: '',
  },
  // Kimi 开放平台：按量付费，中国区 key（platform.kimi.com 充值）。走 pi 内置
  // moonshotai-cn provider（OpenAI 兼容，目录已调好 compat）。
  'kimi-cn': {
    provider: 'moonshotai-cn',
    baseUrl: 'https://api.moonshot.cn/v1',
    api: 'openai-completions',
    models: ['kimi-k3', 'kimi-k2.7-code-highspeed', 'kimi-k2.7-code'],
    defaultModel: 'kimi-k3',
    secretKey: 'MOONSHOT_API_KEY',
  },
  // Kimi Code 订阅（Kimi 会员权益）：Kimi Code 控制台新建的 API Key，走 pi
  // 内置 kimi-coding provider（Anthropic 兼容 api.kimi.com/coding）。档位：
  // Andante=kimi-for-coding；Moderato+=k3/k3-256k；Allegretto+=highspeed。
  'kimi-sub': {
    provider: 'kimi-coding',
    baseUrl: 'https://api.kimi.com/coding',
    api: 'anthropic-messages',
    models: ['k3', 'k3-256k', 'kimi-for-coding-highspeed'],
    defaultModel: 'k3',
    secretKey: 'KIMI_API_KEY',
  },
};

// Must match VISION_DEFAULTS in apps/gateway/src/runtime/vision-call.ts. Shown
// as placeholders only: a blank field is SAVED blank so the gateway resolves the
// default itself. Resolving it here is what used to stamp DashScope model ids
// onto an OpenRouter config — `qwen-vl-ocr` is not an OpenRouter model, so every
// call 400'd and image recognition silently did nothing.
const VISION_DEFAULTS: Record<Exclude<ImageProvider, 'none'>, { ocr: string; describe: string; secret: string }> = {
  dashscope: { ocr: 'qwen-vl-ocr', describe: 'qwen-vl-max', secret: 'DASHSCOPE_API_KEY' },
  openrouter: {
    ocr: 'qwen/qwen3-vl-32b-instruct',
    describe: 'qwen/qwen3-vl-32b-instruct',
    secret: 'OPENROUTER_API_KEY',
  },
};

const IMAGE_PROVIDERS: { value: ImageProvider; label: string; hint: string }[] = [
  { value: 'openrouter', label: 'OpenRouter', hint: '一个 key 覆盖所有模型；默认 qwen3-vl-32b，中文 UI 截图实测最完整' },
  { value: 'dashscope', label: 'DashScope（阿里百炼）', hint: 'qwen-vl 原厂端点，国内直连更快' },
  { value: 'none', label: '不启用', hint: '截图只缓存到本地，agent 需要时自己调 describe_image' },
];

function Field({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint && <span className="mt-1 block text-[10px] leading-relaxed text-muted-foreground/70">{hint}</span>}
    </label>
  );
}

function SectionCard({
  title, desc, action, children,
}: { title: string; desc?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">{title}</h3>
          {desc && <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/70">{desc}</p>}
        </div>
        {action}
      </div>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
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
      {names.length > 12 && (
        <span className="self-center text-[10px] text-muted-foreground/60">+{names.length - 12} more…</span>
      )}
    </div>
  );
}

export default function PiSettingsPage() {
  const getCfg = trpc.machines.getPiConfig.useQuery();
  const setCfg = trpc.machines.setPiConfig.useMutation();
  // Hooks must all be called before any early return (React error #310 otherwise).
  const secrets = trpc.secrets.list.useQuery(undefined, { retry: false });

  const [cfg, setCfgLocal] = useState<PiConfig | null>(null);
  const [modelsText, setModelsText] = useState('');
  const [presetKey, setPresetKey] = useState('custom');
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [revealKey, setRevealKey] = useState(false);

  // Hydrate the form when the server value arrives (and after a save).
  useEffect(() => {
    if (getCfg.data !== undefined) {
      const d = getCfg.data as PiConfig | null;
      const base = {
        ...EMPTY,
        ...(d ?? {}),
        image: { ...(EMPTY.image ?? {}), ...(d?.image ?? {}) },
      } as PiConfig;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- form hydration: the server value is the initial state, and it arrives after mount
      setCfgLocal(base);
      setModelsText((base.models ?? []).join(', '));
      if (base.authMode === 'cc-subscription') {
        setPresetKey('cc-subscription');
      } else if (base.provider === 'moonshotai-cn' || base.provider === 'moonshotai') {
        setPresetKey('kimi-cn');
      } else if (base.provider === 'kimi-coding') {
        setPresetKey('kimi-sub');
      }
    }
  }, [getCfg.data]);

  const set = (patch: Partial<PiConfig>) => setCfgLocal((c) => (c ? { ...c, ...patch } : c));
  const setImg = (patch: Partial<NonNullable<PiConfig['image']>>) =>
    setCfgLocal((c) => (c ? { ...c, image: { ...(c.image ?? {}), ...patch } } : c));

  const imgProvider: ImageProvider = cfg?.image?.provider ?? 'openrouter';
  const imgDefaults = imgProvider === 'none' ? null : VISION_DEFAULTS[imgProvider];
  const imgOn = Boolean(cfg?.image?.enabled) && imgProvider !== 'none';

  const save = async () => {
    setSaveError(null);
    setSaved(false);
    const blank = (v?: string | null) => (v?.trim() ? v.trim() : undefined);
    const next: PiConfig = {
      authMode: cfg?.authMode === 'cc-subscription' ? 'cc-subscription' : 'api-key',
      provider: blank(cfg?.provider),
      baseUrl: blank(cfg?.baseUrl),
      api: blank(cfg?.api) ?? 'anthropic-messages',
      models: modelsText.split(',').map((m) => m.trim()).filter(Boolean),
      defaultModel: blank(cfg?.defaultModel),
      secretKey: blank(cfg?.secretKey) ?? null,
      image: {
        enabled: Boolean(cfg?.image?.enabled),
        provider: imgProvider,
        apiKeySecret: blank(cfg?.image?.apiKeySecret) ?? null,
        // Blank stays blank on purpose — the gateway owns the defaults.
        ocrModel: blank(cfg?.image?.ocrModel),
        describeModel: blank(cfg?.image?.describeModel),
        prompt: blank(cfg?.image?.prompt),
      },
    };
    try {
      await setCfg.mutateAsync({ config: next });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };

  const secretNames = (secrets.data?.keys ?? []).sort();

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <SettingsTabs active="pi" />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 sm:p-6">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Pi Runtime</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              这台机器上 pi 底座用的模型端点，以及端点不支持图片时的识别兜底。
              保存后本机 gateway 30 秒内生效（对新起的 pi 会话），已在跑的会话重启后生效。
              所有 API key 只存 key 名，值留在机器的加密 secrets store 里。
            </p>
            {cfg?.authMode === 'cc-subscription' && (
              <p className="mt-2 rounded-md border border-emerald-600/30 bg-emerald-600/10 px-3 py-2 text-[11px] leading-relaxed text-emerald-600">
                Claude Code 订阅模式：pi 直接复用本机 Claude Code 的 Keychain OAuth 凭据，不消耗
                ANTHROPIC_API_KEY。前提是本机 Claude Code 已登录（订阅可用）；Anthropic 会把 pi 识别为
                Claude Code 客户端，走订阅计划额度。
              </p>
            )}
          </div>

          {getCfg.isLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载中…
            </div>
          ) : (
            <>
              <SectionCard
                title="模型端点"
                desc="任意 Anthropic / OpenAI 兼容端点。pi 不认 base url 环境变量，所以端点要在这里注册成 provider；Kimi 官方端点走 pi 内置 provider，不需要注册。"
              >
                <div className="mb-3">
                  <Field label="端点预设" hint="一键填入官方端点；选自定义则手填。预设只填字段，不保存">
                    <Select
                      value={presetKey}
                      onValueChange={(v) => {
                        setPresetKey(v as string);
                        const p = PROVIDER_PRESETS[v as string];
                        if (p) {
                          set({
                            authMode: v === 'cc-subscription' ? 'cc-subscription' : 'api-key',
                            provider: p.provider,
                            baseUrl: p.baseUrl,
                            api: p.api,
                            secretKey: p.secretKey,
                          });
                          setModelsText(p.models.join(', '));
                          set({ defaultModel: p.defaultModel });
                        }
                      }}
                      modal={false}
                    >
                      <SelectTrigger className="h-9 font-mono" aria-label="endpoint preset">
                        <SelectValue>{(v: string | null) => v || '自定义'}</SelectValue>
                      </SelectTrigger>
                      <SelectContent className="font-mono">
                        <SelectItem value="custom">自定义（手填）</SelectItem>
                        <SelectItem value="cc-subscription">Claude Code 订阅（Keychain OAuth）</SelectItem>
                        <SelectItem value="kimi-cn">Kimi 开放平台 · 按量（moonshotai-cn）</SelectItem>
                        <SelectItem value="kimi-sub">Kimi Code 订阅（kimi-coding）</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Provider ID" hint="pi 里的 provider 名，例如 hyqubit / openrouter">
                    <Input
                      value={cfg?.provider ?? ''}
                      placeholder="hyqubit"
                      onChange={(e) => set({ provider: e.target.value })}
                      className="font-mono text-base sm:text-sm"
                    />
                  </Field>

                  <Field label="API 类型" hint="端点说的是哪套协议">
                    <Select
                      value={cfg?.api ?? 'anthropic-messages'}
                      onValueChange={(v) => set({ api: (v as string) ?? 'anthropic-messages' })}
                      modal={false}
                    >
                      <SelectTrigger className="h-9 font-mono" aria-label="api type">
                        <SelectValue>{(v: string | null) => v || 'anthropic-messages'}</SelectValue>
                      </SelectTrigger>
                      <SelectContent className="font-mono">
                        <SelectItem value="anthropic-messages">anthropic-messages</SelectItem>
                        <SelectItem value="openai-completions">openai-completions</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>

                {cfg?.authMode !== 'cc-subscription' && (
                  <Field label="Base URL" hint="例如 https://litellm.hyqubit.com">
                    <Input
                      value={cfg?.baseUrl ?? ''}
                      placeholder="https://litellm.hyqubit.com"
                      onChange={(e) => set({ baseUrl: e.target.value })}
                      className="font-mono text-base sm:text-sm"
                    />
                  </Field>
                )}

                <Field label="模型列表" hint="逗号分隔；会话详情里的模型下拉读的就是这个列表">
                  <Input
                    value={modelsText}
                    placeholder="claude-opus-5, claude-sonnet-5"
                    onChange={(e) => setModelsText(e.target.value)}
                    className="font-mono text-base sm:text-sm"
                  />
                </Field>

                <Field
                  label="默认模型"
                  hint={cfg?.authMode === 'cc-subscription' ? '订阅可用模型：claude-opus-5 / claude-sonnet-5 / claude-haiku-4-5' : '新建 pi 会话不指定模型时用它。留空则取上面列表的第一个。'}
                >
                  <Input
                    value={cfg?.defaultModel ?? ''}
                    // The head of the list above, since that is what a blank
                    // field resolves to. NOT a hardcoded model id: naming one
                    // here made an unconfigured page read as "everything
                    // defaults to claude-opus-5" when nothing was set at all.
                    placeholder={modelsText.split(',')[0]?.trim() || '列表第一个'}
                    onChange={(e) => set({ defaultModel: e.target.value })}
                    className="font-mono text-base sm:text-sm"
                  />
                </Field>

                {cfg?.authMode === 'cc-subscription' ? (
                  <div className="rounded-md border border-emerald-600/20 bg-emerald-600/5 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                    订阅模式无需 API Key —— pi 用本机 Claude Code 的 Keychain OAuth 凭据认证
                    （`ANTHROPIC_AUTH_TOKEN`，Bearer）。切换回 API key：端点预设选回「自定义」或 Kimi。
                  </div>
                ) : (
                  <Field label="API Key" hint="填 secrets store 里的 key 名，不是 key 本身">
                    <div className="relative">
                      <Input
                        value={cfg?.secretKey ?? ''}
                        placeholder="LITELLM_HYQUBIT_TOKEN"
                        type={revealKey ? 'text' : 'password'}
                        onChange={(e) => set({ secretKey: e.target.value })}
                        className="pr-9 font-mono text-base sm:text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => setRevealKey((v) => !v)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                        aria-label="toggle visibility"
                      >
                        {revealKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                    <SecretPicker names={secretNames} onPick={(k) => set({ secretKey: k })} />
                  </Field>
                )}
              </SectionCard>

              <SectionCard
                title="图片识别"
                desc="端点丢弃 image block 时（hyqubit 会返回 [Unsupported Image]），用独立视觉模型做 OCR + 布局描述，把文本注入上下文；同时给 pi 注册 describe_image 工具，供 agent 主动复查。"
                action={
                  <div className="flex shrink-0 overflow-hidden rounded-md border border-border">
                    {[true, false].map((v) => (
                      <button
                        key={String(v)}
                        type="button"
                        onClick={() => setImg({ enabled: v })}
                        className={cn(
                          'px-2.5 py-1 text-[11px] transition-colors',
                          Boolean(cfg?.image?.enabled) === v
                            ? 'bg-foreground text-background'
                            : 'text-muted-foreground hover:bg-muted',
                        )}
                      >
                        {v ? '启用' : '停用'}
                      </button>
                    ))}
                  </div>
                }
              >
                <div className={cn('flex flex-col gap-4', !imgOn && 'pointer-events-none opacity-50')}>
                  <Field
                    label="识别 Provider"
                    hint={IMAGE_PROVIDERS.find((p) => p.value === imgProvider)?.hint}
                  >
                    <Select
                      value={imgProvider}
                      onValueChange={(v) => setImg({ provider: (v as ImageProvider) ?? 'openrouter' })}
                      modal={false}
                    >
                      <SelectTrigger className="h-9" aria-label="vision provider">
                        <SelectValue>
                          {(v: string | null) =>
                            IMAGE_PROVIDERS.find((p) => p.value === v)?.label ?? 'OpenRouter'}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {IMAGE_PROVIDERS.map((p) => (
                          <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>

                  {imgDefaults && (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="OCR 模型" hint="逐行提取文字。留空用默认">
                        <Input
                          value={cfg?.image?.ocrModel ?? ''}
                          placeholder={imgDefaults.ocr}
                          onChange={(e) => setImg({ ocrModel: e.target.value })}
                          className="font-mono text-base sm:text-sm"
                        />
                      </Field>
                      <Field label="布局描述模型" hint="描述界面结构。留空用默认（可以和 OCR 是同一个）">
                        <Input
                          value={cfg?.image?.describeModel ?? ''}
                          placeholder={imgDefaults.describe}
                          onChange={(e) => setImg({ describeModel: e.target.value })}
                          className="font-mono text-base sm:text-sm"
                        />
                      </Field>
                    </div>
                  )}

                  <Field label="API Key" hint="同样填 key 名。两次调用（OCR + 描述）共用这一个">
                    <Input
                      value={cfg?.image?.apiKeySecret ?? ''}
                      placeholder={imgDefaults?.secret ?? 'OPENROUTER_API_KEY'}
                      onChange={(e) => setImg({ apiKeySecret: e.target.value })}
                      className="font-mono text-base sm:text-sm"
                    />
                    <SecretPicker names={secretNames} onPick={(k) => setImg({ apiKeySecret: k })} />
                  </Field>

                  <Field label="描述 Prompt" hint="只影响布局描述那一次调用；OCR 那次固定用逐行提取的 prompt">
                    <textarea
                      value={cfg?.image?.prompt ?? ''}
                      onChange={(e) => setImg({ prompt: e.target.value })}
                      rows={3}
                      placeholder="留空用默认：列出所有可见文字，并描述界面布局（顶部标题、状态栏、各区块位置和内容）"
                      className="w-full resize-y rounded-md border border-border bg-background p-2 text-[12px] outline-none focus:border-foreground/30"
                    />
                  </Field>

                  {imgOn && !cfg?.image?.apiKeySecret?.trim() && (
                    <p className="flex items-center gap-1.5 text-[11px] text-amber-600">
                      <KeyRound className="h-3.5 w-3.5 shrink-0" />
                      还没选 API key —— 识别会直接跳过，截图只以路径形式给到 agent。
                    </p>
                  )}
                </div>
              </SectionCard>

              <div className="flex items-center gap-3 pb-2">
                <Button onClick={save} disabled={setCfg.isPending}>
                  {setCfg.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  保存设置
                </Button>
                {saved && (
                  <span className="inline-flex items-center gap-1 text-xs text-emerald-500">
                    <CheckCircle2 className="h-3.5 w-3.5" /> 已保存
                  </span>
                )}
                {saveError && (
                  <span className="inline-flex items-center gap-1 text-xs text-rose-500">
                    <AlertTriangle className="h-3.5 w-3.5" /> {saveError}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
