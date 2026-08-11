# Codex 作为第三个 backend

日期：2026-08-11 · 作者：asst · 状态：**已实现**（gateway + dashboard 全链路，E2E 25/25 对真 codex 通过）

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

### 2.2 `TurnCompletedEvent.usage` 是**整个线程的累计值**，不是这一轮的

实测三轮 `input_tokens`：28,916 → 43,477 → 58,065，
而 rollout 文件里同一轮的 `last_token_usage.input_tokens` = **14,588 = 58,065 − 43,477**。

`RuntimeUsage.contextTokens` 的语义是「窗口现在多满」，喂累计值进去，
context bar 只会一路涨满然后钉在 100%——正是 types.ts 里那段注释警告的事。

→ `usageFromTurn()` 做差分。差分需要基线，而 gateway 重启会丢基线，
所以 `ensure()` 在续接线程时从 codex 自己的 rollout JSONL 尾部读最后一条 `token_count`
把基线（和上一轮的真实值）种回去。实测种回来的数和重启前内存里的一模一样。

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

- **codex 的 MCP / 工具扩展**：hermit 的工具（`mcp__hermit__ask` 等）没有注入 codex 会话。
  翻译层已经认 `mcp_tool_call` 并按 `mcp__server__tool` 命名，接上去是加配置不是改结构。
- **图片**：`submit()` 按 `local_image` 实现了，但 chat-runner 现在给 runtime 传的是空数组
  （它走 vision 描述那条路），所以实际没走通。
- **cost**：`costUsd: null`。订阅制没有 per-token 价格，编一个数出来只会让成本列骗人。
- **codex cloud / review 子命令**：不在范围。
