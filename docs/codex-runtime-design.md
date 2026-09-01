# Codex 作为第三个 backend

日期：2026-08-11 · 作者：asst · 状态：**已实现**（gateway + dashboard 全链路，E2E 29/29 对真 codex 通过）

---

## 0. 一句话

`codex-exec` 是 `AgentRuntime` 的第三个实现：用官方 `@openai/codex-sdk` 一轮一个 `codex exec`，
线程存在 codex 自己的 `~/.codex/sessions`，thread id 借 `claudeSessionId` 列回写数据库。
认证走机器本地的 `codex login`，dashboard 不管凭据。

和 pi/omp 最大的不同：**没有常驻子进程**。hibernate / restart 因此几乎免费，
gateway 重启也不需要 pointer 文件。

---

## 1. 为什么是 SDK 而不是 tmux

claude 走 tmux 是为了计费桶（Max 的 Interactive）。codex 没有这个约束——
`codex exec` 和交互式 TUI 用同一份 `~/.codex/auth.json`，同一个 ChatGPT 计划。
既然计费不逼我们进终端，就没有理由再去刮屏：

| | tmux + TUI | SDK（选中） |
|---|---|---|
| 事件 | capture-pane 刮屏，要重写 composer 检测/提交确认/审批弹窗 | 类型化事件流 |
| token | 得从 TUI 文本里抠 | `turn.completed` 带 usage |
| 续接 | 靠 pane 活着 | `resumeThread(id)`，进程死了也在 |
| 中断 | send-keys Escape | `AbortSignal` |

claude 那套 composer/uuid/working 判定磨了很久，为 codex 再磨一遍不划算。

---

## 2. 实测出来的三个坑（都写进代码注释了）

全部对 codex-cli 0.144.1 实测，不是读文档推的。

### 2.1 `item.id` 是**每轮重置**的序号，不是全局唯一

三轮对话拿到的 id 序列：`item_0, item_1, item_2, item_0, item_0`。

dashboard 按 `(sessionId, externalId)` upsert，所以直接拿 `item.id` 当 externalId
的话，**每一轮的第一条消息都会覆盖上一轮的第一条**，聊天记录只剩最后一轮。

→ 每轮在 `submit()` 里发一个 `turnKey`（seq + 时间戳 + 随机后缀），所有 id 都挂它下面。
随机后缀是必需的：gateway 重启后 seq 从 0 开始，否则和原来的第 0 轮撞。

`tool_use.id` 也一样要挂——不然两轮的 `item_1` 会让 tool_result 连到别人的命令上。

### 2.2 `TurnCompletedEvent.usage` 的差分是**整轮消耗**，不是窗口占用

简单对话里一轮通常只调用模型一次，所以累计差分会偶然等于窗口占用；一旦工具调用变多，
同一轮会反复把上下文送进模型，差分就是这些输入的总和。真实故障轮次中，累计输入从
11,308,234 增到 12,111,907，差值是 **803,673**；但该轮最后一次模型调用的输入只有
**26,630**。把前者写进 `contextTokens`，Dashboard 就会显示一个超过窗口三倍的假值。

→ `total_token_usage` 只用于会话累计统计；窗口占用唯一读取 rollout 最新一条
`token_count.info.last_token_usage`。`usage()` 在每次约 8 秒的会话快照采样时读取文件尾，
所以工具密集的长轮次进行中也会更新，而不是一直显示上一轮。文件路径在首次找到后缓存；
gateway 重启时 `ensure()` 从同一个文件种回累计统计和最新窗口值。
即使空闲会话尚未重新 `ensure()`，快照采集也会通过 `storedUsage()` 按持久化的线程编号
直接只读该文件，因此重启后的第一个快照就能纠正数据库旧值，不需要用户先发一条消息。
这条只读恢复路径保持 `alive=false`，不会把休眠会话误唤醒。

自动压缩还有一个边界形态：`last_token_usage.input_tokens/output_tokens` 会短暂写成 0，
但 `total_tokens` 携带压缩后的上下文大小。这个瞬间用 `total_tokens - output_tokens`，避免
进度条先闪成 0，下一次模型调用再跳回正常值。老格式若完全没有 `last_token_usage`，上下文
返回空值；累计消耗不能冒充窗口占用。

### 2.3 续接**不会重放**历史

pi 那条路要 `seen` 集合去重，因为 pi 重连会把 durable entries 重放一遍。
codex 不会：第三轮（换了个进程 resume 的）只发自己这轮的 item。

→ 不需要跨轮去重。唯一的重复是我们**故意**的：`item.started` 和 `item.completed`
用同一个 externalId 发两次 tool_use 行，让长命令在跑的时候就可见，靠 upsert 合并。

---

## 3. 契约怎么对上

| AgentRuntime | codex-exec 怎么实现 |
|---|---|
| `ensure` | `resumeThread(externalSessionId)` 或 `startThread()`；换 model 就重建 Thread（同一个 thread id，历史不丢），mid-turn 不动 |
| `submit` | `runStreamed(input, {signal})`，**后台**消费事件流；立刻返回 true，chat-runner 的 tick 不阻塞 |
| `isWorking` | 内存里的 flag（turn 开始置位，`finally` 清） |
| `interrupt` | `AbortController.abort()`，abort 落在 catch 里发一行 `[turn interrupted]` |
| `compact` | codex 自己管窗口，没有 API → 发一行系统消息说明。**不做静默 no-op**：/compact 看起来没反应和会话卡死在聊天里长得一模一样 |
| `usage` | §2.2 的差分 |
| `stop` | abort + 丢 handle。两种 mode 都保留 thread：会话在 codex 自己的 store 里，下一条消息续上 |

### thread id 存哪

存 `ChatSession.claudeSessionId`——就是 `RuntimeSession.externalSessionId` 的来源，
本来就是为这个设计的（pi 没用它是因为 pi 要的是文件路径 + engine 判别）。

**切回 claude 会不会炸**：不会。chat-runner:1105 在 `--resume` 前会检查
`<uuid>.jsonl` 在不在，codex 的 thread uuid 没有对应 transcript → 走 fresh 分支，
打一行 warn 起一个新 claude 会话。已经处理过的降级路径，不用额外加代码。

### 模型与推理档位

默认 `gpt-5.6-sol` + effort `max` + 服务档位 `fast`（sway 2026-09-01 拍板）。
模型与档位都可被覆盖（session 的 `runtimeModel` > `HERMIT_CODEX_MODEL` > 内置默认）。

数据来自 codex 自己的 `~/.codex/models_cache.json`（client_version 0.152.0）：

| model | 有效上下文 | 档位阶梯 | 自带默认 |
|---|---|---|---|
| `gpt-5.6-sol` ← 用这个 | 258,400 | low·medium·high·xhigh·max·**ultra** | **low** |
| `gpt-5.6-terra` / `luna` | 258,400 | 同上（luna 无 ultra） | medium |
| `gpt-5.5` / `5.4` / `5.4-mini` | 258,400 | 到 xhigh 为止 | medium |
| `gpt-5.3-codex-spark` | 121,600 | 到 xhigh 为止 | high |

两个容易搞错的点：

1. **模型自带默认是 `low`**，不是 medium。也就是说改之前每个 codex 会话都跑在阶梯最底下。
2. **`max` / `ultra` 都不在 SDK 的 `ModelReasoningEffort` 联合类型里**（那个类型停在 `xhigh`，
   比服务端目录旧）。所以那个 `as` 断言是**必需的**，不是图省事——实测 codex-cli 0.152.0
   接受 `max`，rollout 的 turn_context 里记着 `"effort": "max"`。别"顺手修掉"改回 xhigh。

**为什么是 `max` 不是阶梯顶端的 `ultra`**：`ultra` 的官方描述是 "maximum reasoning with
automatic task delegation"——它会自己派生子 agent 干活，那是换了一种行为，不只是想得更久。
`max` 是"仍然一个 agent 自己做"的最深一档。（`ultra` 发的事件类型早先实测过，只有
`agent_message` / `command_execution` / `file_change`，翻译层都认识；所以哪天想换回去，
不用担心事件被静默丢掉。）

### 服务档位：fast

codex 目录里这一档叫 `priority`，展示名 "Fast"，描述是 **"1.5x speed, increased usage"**——
同一个模型同一个答案，插队走，代价是更快吃掉 ChatGPT 套餐额度。`gpt-5.6-sol/terra/luna`、
`gpt-5.5`、`gpt-5.4` 有这一档，`gpt-5.4-mini` 和 `gpt-5.3-codex-spark` 没有。

配置键是 `service_tier`，值写 `fast`（codex 自己的 `/fast` 命令往 config.toml 里写的也是这个
词），codex 组请求时把它解析成 `priority`。

**这里不需要按模型建表**，和 effort 相反：给一个没有这档的模型设了 tier 不是硬失败，codex 只
打一行 `Configured service tier \`priority\` is not advertised as supported for model
gpt-5.4-mini and will be omitted from requests` 然后照常发请求（实测 codex-cli 0.152.0）。
所以钉在某个老模型上的会话不会因此挂掉。

想让某台机器回到普通队列：`HERMIT_CODEX_SERVICE_TIER=default`（或设成空串）。普通队列没有名字
可发——不发这个键**就是**普通队列，所以这两个值的实现都是"不带 `service_tier` 参数"。

### 档位钳制（不是防御性代码）

**不支持的 model+effort 组合是硬失败，不是降级**：`gpt-5.4` + `ultra` 直接
`Codex Exec exited with code 1`，模型根本没看到 prompt。而 session 可以在 dashboard 里
自己钉 `runtimeModel`，所以一刀切 ultra 会让 gpt-5.5 / 5.4 / 5.4-mini / 5.3-codex-spark /
5.6-luna 上的**每一轮**都死——在一个地方改的设置，弄坏另一个地方配置的会话。

`clampEffort()` 按模型的实际上限往下压（表来自 codex 自己的 catalog），压的时候 warn 一次。
实测：一个钉了 gpt-5.4 的 session 现在正常跑完（自动降到 xhigh），而不是每轮报错。

表里没有的模型**不压**：新的前沿模型更可能支持得更多，猜低了会永久静默封顶；
猜错了则是响亮失败，且 runtime 已经把 codex 的原话贴进聊天。

### 上下文大小

`CtxBar` 一直写死除以 1,000,000（Claude Opus 5 的窗口）。codex 的窗口是 258,400，
于是一个真实占用 60% 的会话在界面上显示成轻松的 15%——**数字没错，分数错了**。

新增 `apps/dashboard/src/lib/context-window.ts`，按 backend + model 给分母。
258,400 不是估的：codex 报 `context_window` 272,000、`effective_context_window_percent` 95，
272000×0.95 = 258400，和它 rollout 里记的 `model_context_window` 逐位相同。

**只修了 codex**。claude 保持 1M（本来就对）；pi 也保持——pi 的真实窗口随机器配置的 model 变，
gateway 侧的 `pi-model-limits.ts` 知道，但没有通往前端的路，把它接过去是另一件事、另一个影响面。
在这里瞎猜一个数，就是这次要修的同一类 bug。

### hermit 工具（2026-08-11 补）

**这是一个真实故障的修复，不是补完度。** codex 会话原本只有 shell 和 apply_patch。
用户让 agent 把生成的文件发回来，agent 没有 `attach_file`，于是：
grep 仓库找 `attach_file` → 读 `mcp-stub.cjs` → 检查自己 env 里有没有 `HERMIT_SESSION_ID` →
试图用裸 JSON-RPC 从 stdin 驱动 stub → 最后回复「已发你 yubai-preview.html」。**什么都没发出去。**

一个周边产品默认存在的能力，在某个 backend 上缺失，会被当成「已完成」报告给用户。

修法：codex 从配置读 MCP server，所以 `-c mcp_servers.hermit.{command,args,env}` 指向
**同一个** `mcp-stub.cjs`（claude 用 `--mcp-config` 挂的那个），stub 一行都不用改。

`tool_timeout_sec: 14700` 是必需的：`ask` 会一直阻塞到人在 dashboard 上点按钮
（stub 自己的上限 4h），默认工具超时会早早杀掉它，用户的回答落到一个已经不存在的调用上。
和 claude 那边 14,700,000ms 同一个道理。

实测（codex-cli 0.147.0，真的跑通）：工具以 `hermit/attach_file` 出现，
翻译层渲染成 `mcp__hermit__attach_file`，返回 `ok — file attached`，
dashboard 里出现和 claude 会话一模一样的下载 chip。

### sandbox / approval

`approvalPolicy: 'never'` + `sandboxMode: 'danger-full-access'`，
对齐 claude 那边的 `--dangerously-skip-permissions`。
不是图省事：dashboard 会话**没有 TTY**，任何会弹审批的配置都会让这一轮挂到超时。
两个都能用 env 覆盖（`HERMIT_CODEX_SANDBOX` / `HERMIT_CODEX_APPROVAL`）。

`skipGitRepoCheck: true` 是硬需求——`codex exec` 默认拒绝在非 git 目录启动，
而 agent workspace 大多不是 git 仓库。少了这个，每个会话第一轮就死。

---

## 4. 改了哪些文件

**gateway**
- `src/runtime/codex-events.ts` — 事件 → Anthropic 原生 block（纯函数 + 20 个测试）
- `src/runtime/codex-exec.ts` — runtime 本体
- `src/runtime/index.ts` — `runtimeFor` 认 `codex-exec`；`allRuntimes()` 带上它（hibernate/restart/cancel 三处自动覆盖）
- `src/runtime/types.ts` — `RuntimeKind` 加一个
- `package.json` — `@openai/codex-sdk`

**dashboard**
- `lib/runtime-labels.ts` — 加进 `RUNTIME_KINDS` / `BACKEND_OPTIONS` / blurb / label
  （三个 picker 界面由这张表驱动，加卡片不用碰组件；4 张卡正好回到 2×2）
- `server/runtime-switch.ts` — 换 model 不需要 restart（没有常驻进程要拆）
- `server/routers/{chat,agents}.ts` — 三处 `z.enum` 放行

Mode 下拉在三处都是 `shownBackend === 'pi-rpc'` 才渲染，所以 codex 天然没有 mode 选择器。

---

## 5. 验证

`npm test`（gateway）302/302、dashboard 309/309、两边 `tsc --noEmit` 干净、`build:check` 通过。

E2E 对**真 codex** 跑完整生命周期，25/25：
新线程 → shell 命令渲染成 Bash tool_use + tool_result（id 对得上）→ thread id 回写 →
第二轮记得上一轮 → per-turn usage 小于累计 → `stop()` → 用 thread id 续接（基线从 rollout 种回）→
续接后仍记得对话 → 中断后 isWorking 清掉且聊天里看得见。

脚本：`apps/gateway/scripts/codex-e2e.mts`（要本机 `codex login`）。

---

## 6. 明确没做

- **codex 的 orchestrator（义脑）工具**：`HERMIT_BRAIN=1` 那组跨 agent 工具没接。
  义脑跑在 claude 上，需要时把 `isOrchestrator` 透传进 `RuntimeSession` 即可。
- **图片**：`submit()` 按 `local_image` 实现了，但 chat-runner 现在给 runtime 传的是空数组
  （它走 vision 描述那条路），所以实际没走通。
- **cost**：`costUsd: null`。订阅制没有 per-token 价格，编一个数出来只会让成本列骗人。
- **codex cloud / review 子命令**：不在范围。
