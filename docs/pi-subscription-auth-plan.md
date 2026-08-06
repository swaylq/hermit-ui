# pi runtime 接入 Claude 订阅认证 — 改造方案（v2：含 UI）

Status: plan, 2026-08-06. Companion to `pi-runtime-design.md` 和 `pi-on-claude-code-design.md`。

## 目标

pi runtime 的会话（`new-chat` 与 session detail sheet 里的 pi backend）提供**两种认证方式**可选：

1. **API 接口**（现状）：用 provider 的 API key（`<PROVIDER>_API_KEY` secret），provider 继承 agent 的 `runtimeProvider`
2. **Claude Code 订阅**（新增）：用 `claude setup-token` 生成的 OAuth token（`ANTHROPIC_OAUTH_TOKEN` secret），provider 固定 `anthropic`

试点 agent：`pi-pilot`。零边际模型成本，与 Claude Code 会话共享同一订阅额度窗口。

## 背景机制（调研结论，2026-08-06）

- 第三方 agent 用订阅的官方入口是 `claude setup-token`（"requires Claude subscription"，本地 2.1.223 确认），生成 `sk-ant-oat01-...` 长效 token
- Anthropic 端**模糊分类器**判定请求形状（headers + system prompt + 工具命名）是否「Claude Code 官方使用」：是 → 烧订阅 plan（5h 窗口 + 周上限，响应头 `anthropic-ratelimit-unified-status: allowed`）；否 → extra usage 按 token 计费。黑盒非契约（pi issue #6888）
- **system 第一块身份行是分类器的硬触发器（2026-08-06 二轮实测修正）**：正确形态是 system 数组的**第一个 block 必须逐字**为 `You are Claude Code, Anthropic's official CLI for Claude.`，单独成块；我们的指令放**第二个 block**（`SYSTEM.md` / mode 内容）。逐字匹配：同一 block 里身份行后追加任何文字（含末尾多一个空格）都失败；身份行独立成块 + 内容放第二块则 200 `allowed`。「去掉身份段」不是门槛，**逐字带上 CC 身份**才是——旧结论（去身份段即可）方向错了。
- pi 0.83.0 已内置 stealth OAuth 分支：apiKey 值含 `sk-ant-oat` 前缀自动走（Bearer + `anthropic-beta: claude-code-20250219,oauth-2025-04-20` + `user-agent: claude-cli/*` + `x-app: cli` + Claude Code 规范工具名 + **system[0] 逐字身份行**、`SYSTEM.md` 内容作为 system[1]）
- **env 名很关键（2026-08-06 二轮实测修正）**：`ANTHROPIC_AUTH_TOKEN` 被 pi 解析成普通 `Authorization: Bearer` 头 → **不走** stealth OAuth 分支 → 请求无身份行 → 429 `rate_limit_error` 且无 unified 头（extra usage 额度耗尽时的形态，不是 400 `"out of extra usage"`）。必须用 `ANTHROPIC_OAUTH_TOKEN`（pi 解析成 `auth.apiKey`）才会触发 OAuth 分支。机器级实现已由 AUTH_TOKEN 改为 OAUTH_TOKEN。

## 数据层改动

### schema.prisma

```prisma
model Agent {
  // 新增，紧挨 runtimeProvider：
  // Which credential a pi-rpc session authenticates with.
  // 'api' = the provider's <PROVIDER>_API_KEY secret (current behaviour);
  // 'subscription' = Claude Pro/Max OAuth token (ANTHROPIC_OAUTH_TOKEN),
  // provider is then fixed to 'anthropic'. See docs/pi-subscription-auth-plan.md.
  runtimeAuth          String    @default("api")
  runtimeProvider      String?
  runtimeModel         String?
}

model ChatSession {
  // null = inherit the agent's runtimeAuth. Same resolution as runtime.
  runtimeAuth          String?
  runtimeProvider      String?
  runtimeModel         String?
}
```

一条 migration。`Agent.runtimeAuth` 默认 `'api'`（存量 agent 语义不变）；`ChatSession.runtimeAuth` 默认 null（继承）。

### 解析语义（gateway 侧，与 runtime 的继承逻辑并列）

```
resolvedAuth = session.runtimeAuth ?? agent.runtimeAuth ?? 'api'
```

- `resolvedAuth === 'subscription'` → provider 强制 `'anthropic'`（无视 session/agent 的 runtimeProvider），注入 `ANTHROPIC_OAUTH_TOKEN`
- 否则 → 现状（provider = session.runtimeProvider ?? agent.runtimeProvider，注入 `<PROVIDER>_API_KEY`）

## gateway 改动（三处）

### 1. `apps/gateway/src/runtime/pi-credentials.ts`

`providerEnv` 扩展成接受 auth，或新增 `subscriptionAuthEnv()`：

```ts
/** Claude 订阅认证：token 进 ANTHROPIC_OAUTH_TOKEN（pi 解析顺序先于 ANTHROPIC_API_KEY）。 */
export async function subscriptionAuthEnv(): Promise<Record<string, string>> {
  const value = await readSecret('ANTHROPIC_OAUTH_TOKEN');
  return value ? { ANTHROPIC_OAUTH_TOKEN: value } : {};
}
```

`providerEnv` 保持现状（API key 路径不动）。单测补：`pi-credentials.test.ts` 覆盖 subscription 分支。

### 2. `apps/gateway/src/runtime/pi-rpc.ts`（`boot()`）

```ts
const auth = session.runtimeAuth ?? null; // resolved 在 chat-runner 传下来，或在这里解析
const provider = auth === 'subscription' ? 'anthropic' : session.provider;
env: {
  ...process.env,
  ...(auth === 'subscription' ? await subscriptionAuthEnv() : await providerEnv(provider)),
  ...
}
// RpcClient 的 provider 参数也用解析后的 provider：
const client = new RpcClient({ ..., provider: provider ?? undefined, ... });
```

注意：`RuntimeSession` 类型（`runtime/types.ts`）需要加 `runtimeAuth` 字段，`chat-runner.ts` 组装 session 时带上。

### 3. `apps/gateway/src/chat-runner.ts`

`RuntimeSession` 组装处加 `runtimeAuth: session.runtimeAuth`（或由 chat-runner 解析继承后传 resolved 值——推荐传 resolved，让 pi-rpc 逻辑最薄）。`setSessionRuntime` 的 gateway 侧处理（`apps/gateway/src/api.ts` 或 dashboard router）同步接受 `runtimeAuth`。

## dashboard UI 改动（两处，风格严格参照现有组件）

### 共享数据源：`lib/runtime-labels.ts` 或新 `lib/auth-labels.ts`

参照 `runtime-labels.ts` 的单一数据源模式（三处渲染同表、无 ternaries）。新增：

```ts
export const AUTH_KINDS = ['api', 'subscription'] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];
export function authLabel(kind: string | null | undefined): string {
  return kind === 'subscription' ? 'Claude 订阅' : 'API key';
}
export const AUTH_BLURB: Record<AuthKind, string> = {
  api: '用 provider 的 API key（secrets store 里的 <PROVIDER>_API_KEY）。',
  subscription: '用 Claude Pro/Max 订阅额度（claude setup-token 生成的 OAuth token），与 Claude Code 共享窗口。',
};
```

### 新组件：`components/chat/auth-picker.tsx`（参照 `backend-picker.tsx`）

`BackendPicker` 的缩小版：两卡 segmented radio，同样的卡片视觉（`rounded-lg border px-3 py-2.5 text-left`、active=`border-foreground/40 bg-accent`、`text-[11px]` blurb）。带 `agentDefault` 标记（参照 BackendPicker 的 `default` 徽标）。不放 portal，避免 base-ui overlay 嵌套坑。

```tsx
export function AuthPicker({
  value, onChange, disabled, agentDefault,
}: { value: AuthKind; onChange: (v: AuthKind) => void; disabled?: boolean; agentDefault?: string | null }) { ... }
```

### 3. `components/chat/new-chat-pane.tsx`

`chosen === 'pi-rpc'` 的块里，Model 输入框**上方**插入：

```tsx
<div className="block">
  <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Auth</span>
  <div className="mt-1.5">
    <AuthPicker value={chosenAuth} onChange={setAuth} agentDefault={agentAuth ?? 'api'} />
  </div>
</div>
```

- state：`const [auth, setAuth] = useState<AuthKind | null>(null)`（null = agent 默认，切 agent 时重置——参照现有 runtime 的 reset 逻辑）
- `chosen === 'subscription'` 时 Model placeholder 提示改为 `claude-sonnet-5` 之类；provider 概念对用户隐藏（固定 anthropic）
- `create.mutate` 增加 `...(chosen === 'pi-rpc' ? { runtimeAuth: chosenAuth } : {})`
- 表单 label 文案用现有风格（`text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground`），hint 用小号 muted（参照 /pi 页面的中文 hint 风格）

### 4. `components/chat/session-detail-sheet.tsx`

`shownRuntime === 'pi-rpc'` 的 model 块上方插入同样 AuthPicker：

- state：`const [auth, setAuth] = useState<AuthKind | null>(null)`；stamp 串扩成 `${sessionId}|${runtime}|${runtimeModel}|${runtimeAuth}`
- `save.mutate` 增加 `runtimeAuth: shownRuntime === 'pi-rpc' ? chosenAuth : null`
- `dirty` 判断加 auth
- 继承提示文案沿用现有模式（"Inherited from agentName" / "Set on this session"），auth 的继承也显示
- 订阅模式时 model 输入框 placeholder 提示可写 `claude-sonnet-5`；显示一行只读提示「provider 固定 anthropic，走订阅额度」

### 5. chat 页 header chip（`app/chat/page.tsx` 的 `runtimeDetail`）

`runtimeDetail` 加 auth 维度：`pi · anthropic · subscription` 或保持 `pi · provider · model` 不变（auth 不明显展示，detail sheet 里有）——**保持现状**，减少改动面；如果要做，`runtime-labels.ts` 的 `runtimeDetail` 加参数即可。

## 需要同步改的 schema 消费者

- `apps/gateway/src/chat-runner.ts`：`RuntimeSession` 类型 + session 组装 + `setSessionRuntime` 透传
- `apps/dashboard/src/server/routers/chat.ts`：`setSessionRuntime` input 加 `runtimeAuth: z.string().max(16).nullish()`；`createSession` 同理；detail 查询 select 加 `runtimeAuth`
- `apps/dashboard/src/app/chat/page.tsx`：new-chat 的 submit 透传（如果 new-chat-pane 已处理则不用）
- 三处 Prisma select 列表（`agents.ts:156`、`chat.ts` 各 detail/list select）补 `runtimeAuth`

## 实施步骤

- **P0 试点（~30 min）**：`claude setup-token` → `printf %s '<token>' | secret set ANTHROPIC_OAUTH_TOKEN` → 手动把 pi-pilot 的 runtimeProvider 设为 anthropic + 临时在 pi-credentials 注入（或直接 env 验证）→ 一轮对话 → 响应头确认 `allowed`
- **P1 数据层 + gateway（~2 h）**：schema migration → gateway 三处改动 + 单测 → typecheck
- **P2 UI（~3 h）**：`auth-labels.ts` → `auth-picker.tsx` → new-chat-pane → session-detail-sheet → typecheck + 本机构建
- **P3 部署 + 验证（~1 h）**：VPS 构建 + 三台 gateway pull/restart → 真机 UI 测两处入口 → 订阅窗口观测一周

## 验证清单

1. pi-pilot 发一轮对话，响应头 `anthropic-ratelimit-unified-status: allowed`（走订阅）而非 400 extra usage
2. `claude.ai/settings/usage` extra usage 不涨，烧的是 plan 5h 窗口
3. new-chat：选 pi + subscription → 创建会话 → header chip / detail sheet 正确显示
4. session-detail-sheet：api ⇄ subscription 切换 → Apply 后会话重建走对应认证
5. 继承语义：session 不选时继承 agent 默认（`api`）
6. 回滚：切回 API key，无需任何代码改动（dashboard 一个选择）

## 风险与缓解

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 分类器收紧 | 黑盒模糊匹配，非契约；可能掉 extra usage 或被限制 | 验证固定化；异常立即切回 API key |
| 共享订阅窗口 | 与 Claude Code 24 会话共享 5h/周额度 | 试点限 1-2 个低流量 agent |
| token 生命周期 | setup-token 长效 token 过期/revoke 需重生成 | 文档写明步骤；secrets store 单点改值 |
| 账户政策 | 订阅凭据用于第三方 harness 属 unsupported surface | 只试点；UI 有回滚入口 |
| 误配（subscription 但没配 token） | ANTHROPIC_OAUTH_TOKEN secret 缺失时 pi 会 fallback 到 ANTHROPIC_API_KEY 或无认证 | gateway 端 resolved 时打 warning；UI 订阅卡片 hint 写明「需要先 secret set ANTHROPIC_OAUTH_TOKEN」 |

## 机器级方案（已实现，2026-08-06）— 与本文 agent 级方案互补

> 本文是 agent/会话级粒度（`Agent.runtimeAuth` / `ChatSession.runtimeAuth`）。同日另实现了**机器级**入口：
> Settings → Pi Runtime（`/pi` 页）新增「Claude Code 订阅」预设（`Machine.piConfig.authMode = 'cc-subscription'`）。
> 两者正交：/pi 页定机器默认认证；agent/会话级可在其上细化。机器级实现见下（agent 级仍按本文推进）。

已改文件：
- `apps/dashboard/src/server/routers/machines.ts`：`PI_CONFIG_SCHEMA` 加 `authMode`（'api-key' | 'cc-subscription'）
- `apps/dashboard/src/app/pi/page.tsx`：预设下拉加「Claude Code 订阅（Keychain OAuth）」；订阅模式下隐藏 Base URL / API Key 字段并显示说明
- `apps/gateway/src/pi-config.ts`：`PiConfig` 加 `authMode`，merge 透传（默认 'api-key'）
- `apps/gateway/src/runtime/pi-credentials.ts`：`machineProviderEnv()` 加 cc-subscription 分支——读 macOS Keychain 的 `Claude Code-credentials` 条目（`claudeAiOauth.accessToken`，Claude Code 自己的凭据，自动刷新轮换）注入 `ANTHROPIC_OAUTH_TOKEN`（**必须 OAUTH_TOKEN 不是 AUTH_TOKEN**，见背景机制）；幂等写入干净 `SYSTEM.md` 到 `~/.pi/agent/`（已有则不动）

**SYSTEM.md 修正（必须，实测）**：pi 默认 system 含 pi/harness 身份段，会破坏分类器对身份行的判定。cc-subscription 分支会确保 `~/.pi/agent/SYSTEM.md` 存在（干净版，无身份段）——它的内容作为 system 第二块，身份行由 pi-ai 的 OAuth 分支作为第一块提供。若用户已有自定义 SYSTEM.md 则尊重不覆盖。

**与 agent 级方案的取舍**：Keychain 实时读 token（本方案）免 setup-token 手动维护、token 自动轮换；setup-token 存 secret（agent 级方案）可在无 Claude Code CLI 的机器上用。P0 验证后可考虑把 agent 级也接到 Keychain 读（改 `subscriptionAuthEnv` 来源）。

## 相关文件

- pi: `earendil-works/pi` `packages/ai/src/providers/anthropic.js`、`packages/ai/src/api/anthropic-messages.js`（OAuth 分支）；issue #6888 / #5821 / #6959
- hermit UI 参照：`components/chat/backend-picker.tsx`、`lib/runtime-labels.ts`、`components/chat/new-chat-pane.tsx`、`components/chat/session-detail-sheet.tsx`、`app/pi/page.tsx`（Field/SectionCard/中文 hint 风格）
- hermit gateway：`apps/gateway/src/runtime/pi-credentials.ts`、`pi-rpc.ts`、`chat-runner.ts`、`pi-config.ts`
