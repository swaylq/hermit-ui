# pi 底座接入 Kimi 模型（moonshotai-cn / kimi-coding）

Status: implemented, 2026-08-06. 未实测（缺 API key）。

## 结论先行

pi 底座**不需要新建 provider**——`@earendil-works/pi-ai` 内置了两条 Kimi 路径：

1. **`moonshotai-cn`（开放平台 · 按量付费）**：`api.moonshot.cn/v1`，OpenAI 兼容，模型 `kimi-k3`（1M/原生视觉/`deferredToolsMode: "kimi"`）、`kimi-k2.7-code*`、`kimi-k2.6`，目录已调好。
2. **`kimi-coding`（Kimi Code 订阅 · Kimi 会员权益）**：`api.kimi.com/coding`，**Anthropic 兼容**，模型 `k3`（1M）、`k3-256k`、`kimi-for-coding`、`kimi-for-coding-highspeed`，compat 含 `forceAdaptiveThinking`。key 在 Kimi Code 控制台新建，env `KIMI_API_KEY`。

hermit 侧只缺三样接线：

1. gateway 把 `MOONSHOT_API_KEY` / `KIMI_API_KEY` 注入 pi 子进程 env（pi 的内置 provider 读这些变量）；
2. 机器 provider 配成 `moonshotai-cn` / `kimi-coding` 时，hermit 扩展**跳过自定义注册**，避免用扁平模型结构覆盖 pi 的调优目录（否则会丢掉 compat/thinkingLevelMap，context window 也会回落到猜测值 200k，重复 2026-08-06 的 auto-compact 过早 bug）；
3. Settings → Pi Runtime 加一键预设 + 修 API 类型下拉的非法值 `openai` → `openai-completions`。

## 改动清单

| 文件 | 改动 |
|---|---|
| `apps/gateway/src/runtime/pi-credentials.ts` | `envVarForProvider` 增加内置 provider 覆盖表（镜像 pi-ai `env-api-keys.js`）：`moonshotai`/`moonshotai-cn` → `MOONSHOT_API_KEY`，`kimi-coding` → `KIMI_API_KEY`，`huggingface` → `HF_TOKEN`。secret 名 = env 变量名。 |
| `apps/gateway/src/runtime/pi-rpc.ts` | boot env 改为注入 `providerEnv(session.provider ?? machineProvider)`——之前只注入 session pin，机器 provider 的 key 永远不会进子进程。 |
| `apps/gateway/src/runtime/hermit-pi-extension.ts` | `BUILTIN_PI_PROVIDERS = {moonshotai, moonshotai-cn, kimi-coding}` 跳过注册；`MODEL_CONTEXT_WINDOW` 补 kimi 系列（k3: 1M/131072，k2.7-code 系: 256K/131072），供自定义注册兜底路径使用。 |
| `apps/dashboard/src/app/pi/page.tsx` | 端点预设下拉（按量 moonshotai-cn / 订阅 kimi-coding）；API 类型下拉 `openai` → `openai-completions`；加载时 provider 为 moonshot/kimi-coding 系自动选中对应预设。 |
| `apps/gateway/src/runtime/pi-credentials.test.ts` | 内置 provider env 映射测试。 |

## 配置步骤（用户侧）

### 按量付费（moonshotai-cn）

1. 在 `platform.kimi.com` 创建中国区 API Key 并充值（K3 需要余额，新用户认证赠券不可用）；K2.5/moonshot-v1 已停新注册，8/31 全线下线。
2. 存入 secrets store：`secret set MOONSHOT_API_KEY`（值走 stdin，不落 transcript）。
3. Dashboard → Settings → Pi Runtime → 预设选「Kimi 开放平台 · 按量」→ 保存。默认模型 `kimi-k3`。

### Kimi Code 订阅（kimi-coding）

1. 订阅 Kimi 会员（含 Kimi Code 权益）。档位：Andante=`kimi-for-coding`(256K)；Moderato+=`k3`/`k3-256k`；Allegretto+=`kimi-for-coding-highspeed`；`k3` 1M 上下文。
2. 登录 **Kimi Code 控制台** → 「新建 API Key」→ 复制（关闭弹窗后无法再看完整 Key）。
3. 存入 secrets store：`secret set KIMI_API_KEY`。
4. Dashboard → Settings → Pi Runtime → 预设选「Kimi Code 订阅」→ 保存。默认模型 `k3`。

两条路 key 不通用（Kimi Code Key vs 平台 API key），端点也不同（`api.kimi.com/coding` vs `api.moonshot.cn/v1`）。订阅额度 7 天刷新、5h 滚动频限、共享配额；可开加油包兜底（单价近似开放平台 API）。

## 已知约束

- **订阅路线的坑**：Kimi 官方文档明确「关闭 thinking 后 K3/K2.7 Code 会被路由到 K2.6」——pi 的 kimi-coding 模型 thinkingLevelMap 已把 off 标为不支持，但请勿在会话里强制关思考。Claude Code 场景的模型名 `k3[1m]` 写法只适用于 Claude Code；pi 的 Model ID 直接用 `k3`（pi 目录 contextWindow 已声明 1M）。
- **K3 定价**：输入 ¥20/M（缓存命中 ¥2/M）、输出 ¥100/M，1M 上下文；K2.7 Code 高速版约 180-260 tok/s，coding 场景更划算。
- pi 目录里 k3 的 `maxTokens: 131072` 与 Kimi API 文档默认 `max_completion_tokens` 一致；K3 始终思考，`reasoning_effort` 顶层参数走 pi 的 thinkingLevelMap（low/high/max）。
- `moonshotai-cn` 是内置 provider，Settings 页的 Base URL / API 类型对它不生效（仅信息性）。
- 图片：k3 原生支持 image 输入，无需「图片识别」兜底；`describe_image` 工具在视觉配置关闭时仍会提示未配置（对 k3 会话直接用 Read 看图即可）。
- 待实测项：K3 流式响应是否返回 usage（pi 目录未标 `supportsUsageInStreaming: false`，若 Kimi 流式不含 usage，token 记账会失真）、`max_tokens`（已弃用字段）是否仍被接受、`deferredToolsMode: "kimi"` 与 hermit 扩展工具的实际协作、订阅端点（api.kimi.com 为国际站域名）国内网络可达性。

## 参考

- Kimi 官方文档：Hermes / OpenClaw / Claude Code 接入指南、官方 Formula 工具、模型参数参考（`platform.kimi.com/docs/llms.txt`）。
- 前置调研：`hermit-agent/docs/kimi-integration.md`（OSS agent 侧方案，含 --model kimi 的 claude host 路线）。
