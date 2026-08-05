'use client';

import { useState, useEffect } from 'react';
import { Loader2, Save, RotateCcw, CheckCircle2, AlertTriangle, Eye, EyeOff } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SettingsTabs } from '@/components/settings-tabs';

type PiConfig = {
  provider?: string;
  baseUrl?: string;
  api?: string;
  models?: string[];
  secretKey?: string | null;
  image?: {
    enabled?: boolean;
    provider?: 'dashscope' | 'openrouter' | 'none';
    apiKeySecret?: string | null;
    ocrModel?: string;
    describeModel?: string;
    prompt?: string;
  };
};

const EMPTY: PiConfig = {
  provider: '',
  baseUrl: '',
  api: 'anthropic-messages',
  models: [],
  secretKey: '',
  image: {
    enabled: false,
    provider: 'dashscope',
    apiKeySecret: '',
    ocrModel: 'qwen-vl-ocr',
    describeModel: 'qwen-vl-max',
    prompt: '',
  },
};

const SECRET_HINTS: Record<string, string> = {
  LITELLM_HYQUBIT_TOKEN: 'hyqubit 的 litellm key（本机 secrets store）',
  DASHSCOPE_API_KEY: '阿里云百炼 DashScope key',
  OPENROUTER_API_KEY: 'OpenRouter key',
};

function Field({
  label, hint, children, className,
}: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label className="text-xs font-medium text-foreground/80">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground/70 leading-relaxed">{hint}</p>}
    </div>
  );
}

export default function PiSettingsPage() {
  const getCfg = trpc.machines.getPiConfig.useQuery();
  const setCfg = trpc.machines.setPiConfig.useMutation();

  const [cfg, setCfgLocal] = useState<PiConfig | null>(null);
  const [modelsText, setModelsText] = useState('');
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
      setCfgLocal(base);
      setModelsText((base.models ?? []).join(', '));
    }
  }, [getCfg.data]);

  if (getCfg.isLoading) {
    return (
      <div className="p-6 space-y-4">
        <SettingsTabs active="pi" />
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
        </div>
      </div>
    );
  }

  const set = (patch: Partial<PiConfig>) => setCfgLocal((c) => (c ? { ...c, ...patch } : c));
  const setImg = (patch: Partial<NonNullable<PiConfig['image']>>) =>
    setCfgLocal((c) => (c ? { ...c, image: { ...(c.image ?? {}), ...patch } } : c));

  const save = async () => {
    setSaveError(null);
    setSaved(false);
    const next: PiConfig = {
      provider: cfg?.provider?.trim() || undefined,
      baseUrl: cfg?.baseUrl?.trim() || undefined,
      api: cfg?.api?.trim() || 'anthropic-messages',
      models: modelsText.split(',').map((m) => m.trim()).filter(Boolean),
      secretKey: cfg?.secretKey?.trim() || null,
      image: cfg?.image
        ? {
            enabled: Boolean(cfg.image.enabled),
            provider: cfg.image.provider ?? 'dashscope',
            apiKeySecret: cfg.image.apiKeySecret?.trim() || null,
            ocrModel: cfg.image.ocrModel?.trim() || 'qwen-vl-ocr',
            describeModel: cfg.image.describeModel?.trim() || 'qwen-vl-max',
            prompt: cfg.image.prompt?.trim() || undefined,
          }
        : undefined,
    };
    try {
      await setCfg.mutateAsync({ config: next });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };

  const secrets = trpc.secrets.list.useQuery(undefined, { retry: false });
  const secretNames = (secrets.data?.keys ?? []).sort();

  return (
    <div className="p-6 space-y-4">
      <SettingsTabs active="pi" />
      <div>
        <h1 className="text-lg font-semibold">Pi Runtime 设置</h1>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
          配置本机 pi 底座的模型端点（hyqubit 或任意 Anthropic 兼容端点）与图片识别。
          保存后由本机 gateway 自动生效（新起的 pi 会话），现有会话重启后生效。
          所有 API key 只存 key 名，值保留在机器的加密 secrets store 里。
        </p>
      </div>

      <Card className="p-4 space-y-4">
        <h2 className="text-sm font-semibold text-foreground/90">① 模型端点（hyqubit）</h2>

        <Field label="Provider ID" hint="pi 的 provider 名，例如 hyqubit / openrouter / deepseek">
          <Input
            value={cfg?.provider ?? ''}
            placeholder="hyqubit"
            onChange={(e) => set({ provider: e.target.value })}
          />
        </Field>

        <Field label="Base URL" hint="Anthropic 兼容端点的 base url，例如 https://litellm.hyqubit.com">
          <Input
            value={cfg?.baseUrl ?? ''}
            placeholder="https://litellm.hyqubit.com"
            onChange={(e) => set({ baseUrl: e.target.value })}
          />
        </Field>

        <Field label="API 类型">
          <select
            className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={cfg?.api ?? 'anthropic-messages'}
            onChange={(e) => set({ api: e.target.value })}
          >
            <option value="anthropic-messages">anthropic-messages</option>
            <option value="openai">openai</option>
          </select>
        </Field>

        <Field label="模型列表" hint="逗号分隔，例如 claude-opus-5, claude-sonnet-5, claude-haiku-4-5">
          <Input value={modelsText} placeholder="claude-opus-5, claude-sonnet-5" onChange={(e) => setModelsText(e.target.value)} />
        </Field>

        <Field
          label="API Key（secrets store 里的 key 名）"
          hint={cfg?.secretKey ? SECRET_HINTS[cfg.secretKey] : '例如 LITELLM_HYQUBIT_TOKEN（存在本机 secrets store）'}
        >
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                value={cfg?.secretKey ?? ''}
                placeholder="LITELLM_HYQUBIT_TOKEN"
                type={revealKey ? 'text' : 'password'}
                onChange={(e) => set({ secretKey: e.target.value })}
                className="pr-9 font-mono text-xs"
              />
              <button
                type="button"
                onClick={() => setRevealKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="toggle visibility"
              >
                {revealKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          {secretNames.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {secretNames.slice(0, 12).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => set({ secretKey: k })}
                  className="rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {k}
                </button>
              ))}
              {secretNames.length > 12 && (
                <span className="text-[10px] text-muted-foreground/60">+{secretNames.length - 12} more…</span>
              )}
            </div>
          )}
        </Field>
      </Card>

      <Card className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground/90">② 图片识别（vision fallback）</h2>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">{cfg?.image?.enabled ? '已启用' : '已停用'}</span>
            <div className="flex rounded-md border border-border overflow-hidden">
              {[true, false].map((v) => (
                <button
                  key={String(v)}
                  type="button"
                  onClick={() => setImg({ enabled: v })}
                  className={cn(
                    'px-2.5 py-1 text-xs transition-colors',
                    Boolean(cfg?.image?.enabled) === v
                      ? 'bg-foreground text-background'
                      : 'text-muted-foreground hover:bg-muted',
                  )}
                >
                  {v ? '启用' : '停用'}
                </button>
              ))}
            </div>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
          当模型端点不支持图片（如 hyqubit 会丢弃 image block）时，自动用独立视觉模型
          对上传的截图做 OCR + 布局描述，把文本注入 agent 上下文，并在 pi 底座注册
          <code className="font-mono text-[10px] bg-muted px-1 rounded">describe_image</code> 工具供主动复查。
        </p>

        <div className={cn('space-y-4', !cfg?.image?.enabled && 'opacity-50 pointer-events-none')}>
          <Field label="识别 Provider">
            <select
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={cfg?.image?.provider ?? 'dashscope'}
              onChange={(e) => setImg({ provider: e.target.value as 'dashscope' | 'openrouter' | 'none' })}
            >
              <option value="dashscope">DashScope（阿里 qwen-vl，中文 UI 识别最佳）</option>
              <option value="openrouter">OpenRouter（gpt-4o / gemini 等）</option>
              <option value="none">无（仅用 macOS Vision OCR 兜底）</option>
            </select>
          </Field>

          {cfg?.image?.provider === 'dashscope' && (
            <>
              <Field label="OCR 模型" hint="纯文字提取（推荐 qwen-vl-ocr）">
                <Input value={cfg?.image?.ocrModel ?? 'qwen-vl-ocr'} onChange={(e) => setImg({ ocrModel: e.target.value })} />
              </Field>
              <Field label="布局描述模型" hint="界面布局/元素描述（推荐 qwen-vl-max）">
                <Input value={cfg?.image?.describeModel ?? 'qwen-vl-max'} onChange={(e) => setImg({ describeModel: e.target.value })} />
              </Field>
            </>
          )}

          {cfg?.image?.provider === 'openrouter' && (
            <Field label="模型" hint="例如 openai/gpt-4o-mini 或 google/gemini-2.5-flash">
              <Input value={cfg?.image?.ocrModel ?? 'openai/gpt-4o-mini'} onChange={(e) => setImg({ ocrModel: e.target.value })} />
            </Field>
          )}

          <Field
            label="API Key（secrets store 里的 key 名）"
            hint="DashScope → DASHSCOPE_API_KEY；OpenRouter → OPENROUTER_API_KEY"
          >
            <Input
              value={cfg?.image?.apiKeySecret ?? ''}
              placeholder={cfg?.image?.provider === 'dashscope' ? 'DASHSCOPE_API_KEY' : 'OPENROUTER_API_KEY'}
              onChange={(e) => setImg({ apiKeySecret: e.target.value })}
              className="font-mono text-xs"
            />
          </Field>

          <Field label="描述 Prompt（可选）" hint="留空用默认：提取全部可见文字 + 描述界面布局">
            <Input
              value={cfg?.image?.prompt ?? ''}
              placeholder="列出截图里所有可见文字，并描述界面布局"
              onChange={(e) => setImg({ prompt: e.target.value })}
            />
          </Field>
        </div>
      </Card>

      <div className="flex items-center gap-3">
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
    </div>
  );
}
