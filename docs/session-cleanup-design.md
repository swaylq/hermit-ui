# 会话清理

2026-08-09 · dashboard + gateway · **已实现**（migration `20260809180000_session_cleanup`）

## 现状：三种资源在漏，只有一种有人管

「会话太多了，清一清」听上去是一件事，实际是三件，泄漏速度和后果都不一样：

| 资源 | 谁占着 | 现有机制 | 缺口 |
|---|---|---|---|
| **内存** | `hermit-*` pane 里活着的 `claude`（100–500 MB/个） | hibernate + reaper（`resource-governance-design.md`） | **孤儿 pane：DB 里没有行，任何 reaper 都看不见** |
| **注意力** | 侧栏 125 行 | `hiddenAt` / `closedAt` / 分组 | 没有任何东西会主动收敛这个列表 |
| **存储** | ChatMessage 行 + `~/.claude/projects/*.jsonl` | 无 | 1.8 GB transcript，904 MB 正文 JSON，只增不减 |

内存那一栏 hibernate 已经解决了 —— 对**账上有名**的会话。所以「清理」真正要做的是注意力和存储，
外加堵住一个今天就在漏、而且会被批量清理放大的洞。

## 实测（mac001，2026-08-09）

125 个会话（`listSessions` 上限 200，没截断），按「最后一条消息距今」：

| <1d | 1–3d | 3–7d | 7–14d | 14–30d | 30d+ |
|---|---|---|---|---|---|
| 13 | 18 | 23 | 26 | 15 | **30** |

**57%（71 个）超过 7 天没说过话。** 状态分布：alive 28 / hibernated 41 / closed 5 / hidden 4 / 归到分组 3 / 未读 4。

上下文体量 p10 38.9k、p50 **187k**、p90 683k、p99 899k tokens —— 中位数会话已经装着 18 万 token 的上下文，
这数字同时说明两件事：留着它不便宜，删掉它也不是没成本。

磁盘：`~/.claude/projects` 1,923 个 JSONL / 1.8 GB（0–7d：84 个 388 MB；7–30d：1,518 个 1,299 MB；30–90d：321 个 62 MB）。

机器本身：16 GB RAM，144 个 claude 进程，合计 7.4 GB RSS。

## 先说坑：今天的 `deleteSession` 会漏进程

`chat.deleteSession` 的注释说 pane「harmless, idle, reclaimed on the next gateway restart」。
**这句话是错的**，三处代码都能证：

- 杀 pane 只有一条路 —— `hibernateOneSession`（`chat-runner.ts:257`），而它只被
  `chatHibernateTick` / `reaperTick` 调用，两者的输入都来自 DB 轮询（`pollHibernations` / `pollReapCandidates`）。
- 重连循环（`chat-runner.ts:405`）只遍历 `pollChatPending` 返回的会话。
- gateway 启动时没有任何孤儿清扫；`tmux-driver` 里那个 `listSessions(prefix)`（`index.ts:98`）**零调用方**。

**行没了 = 这个 pane 从此不在任何一张表里。** 它不会被 reap，不会被 hibernate，不会被重启回收 ——
只有关机或手工 `tmux kill-session` 能动它。

这台机器上现在就有 **13 个孤儿 pane**，idle 0.5–8.6 天，进程组 RSS 合计 **1.54 GB**：

```
785949476821 3.6d   786037961206 2.5d   786103385607 1.8d   pv16gushfjas 3.9d
pv1rg7ceww1p 8.6d   pv2096yok0i0 4.0d   pvjolb06dqy3 0.5d   pvjom2w8bv7q 0.5d
pvjornw7jkgl 1.4d   pvjosigv3aoj 0.8d   pvkh2mzl86xa 3.5d   pvs5kq8k6qv6 4.0d
pvypkrtuf1qi 3.1d
```

（pane 名是 `hermit-<cuid 后 12 位>`，见 `paneName()`。对账要按后 12 位比，不是整个 id。）

16 GB 的机器上 1.54 GB 无法回收 —— 这正是 `resource-governance-design.md` 里 macmini1 雪崩的同一个形状，
只是这次泄漏源是删除而不是闲置。

**所以顺序是设计的一部分**：一个「一键清 45 个会话」的按钮，如果建在今天的 `deleteSession` 上，
一次点击可以造出 45 个孤儿 pane，把整理变成一次内存事故。**必须先睡后删**，见下面的不变式。

顺带记一笔：另有 5 个会话 DB 里 `alive=true` 但 pane 不存在 —— `alive` 列会失真，
清理判定不能只信它（reaper 已经在杀之前重查真 pane，清理沿用同一条规矩）。

## 判据：什么叫「可以清」

你提的第一条（没绑 cron）是一个更普遍规则的特例：

> **一个会话可以清，当且仅当系统里没有别的东西还指着它，也没有人还在等它。**

会话在这个系统里是个**被引用对象**。把 schema 里所有入边列全，就是完整的阻断表 ——
任一命中就不清（`Cron.reportSessionId` 那行就是你的 #1）：

| 阻断项 | 判据 | 为什么 |
|---|---|---|
| **cron 指着它** | `Cron.reportSessionId = id` | 你的 #1。而且外键是 `onDelete: SetNull` —— 删了**不报错**，那个 cron 从此静默地没有汇报去处 |
| **未读** | `lastMessageAt > lastReadAt` | 删掉一条你从没看过的回复 |
| **待答交互** | `Interaction.status = 'pending'` | 卡在权限弹窗上的会话，长相和「闲置很久」一模一样，却恰恰最不能删 |
| **排队未投递** | `role='user' AND deliveredAt IS NULL AND externalId IS NULL` | 你打了字，还没送进去 |
| **未答标记** | `unansweredMsgId IS NOT NULL` | 你问了，没人答 |
| **在跑 loop** | `loopState.loops[].status = 'running'` | reaper 已有此守卫，复用 `hasRunningLoop()` |
| **正在干活** | `state = 'working'` | 同上 |
| **Brain 关联** | `dispatchedBySessionId` / `takeoverBySessionId` 非空，或被别人指着 | 删了子会话，Brain 的 dispatch-watcher / takeover-watcher 后续断链 |
| **归了分组** | `groupId IS NOT NULL` | 有人专门把它归过档 |
| **人起的标题** | `title` 非空 且 `titleAuto=false` 且 **`origin` 为空** | 有人专门给它起过名。`origin` 那个条件是上线后实测补的：`titleAuto` 列**默认就是 false**，而 `createSession` 收 `title` 时从不盖这个戳 —— 于是每个机器开出来带标题的会话（dispatch 的 `Brain → agent`、takeover、cron，全 fleet 27 行）都被读成「人特意起的名」而永久豁免。只有 `chat.setTitle`（重命名对话框）才真的代表人打了字，而那条路径的 `origin` 一定为空 |
| **置顶保留** | `keepAt IS NOT NULL`（新增） | 「别再问我这个」 |

Share 不用管：share key 是 agent 粒度的（`share.ts` 全按 `agentName`），没有会话级分享链接。
用量也不用管：`UsageHourly` 按 (机器, agent, 小时) 分桶，不挂会话 —— **删会话不会丢任何账和花费历史**，
这一点值得在 UI 上明写，否则没人敢点。

## 清理不是一个动作，是一道阶梯

四个档位，可逆性差一个数量级，代价也差一个数量级：

| 档 | 做什么 | 释放 | 怎么撤 | 现状 |
|---|---|---|---|---|
| **睡** | 杀 pane，留行 + transcript | 内存 | 发条消息就醒（`--resume`） | 已有 |
| **归档** | `closedAt` | 侧栏 | 一键 reopen | 已有，但 UI 几乎没入口 |
| **回收站** | `trashedAt` | 侧栏 + 心理负担 | N 天内恢复 | **新增** |
| **抹除** | 删行 + ChatMessage + transcript | DB + 磁盘 | 不可逆 | 已有，但有上面那个漏进程的 bug |

回收站这一档照抄 `Agent.trashedAt` 已经跑通的形状（gateway 把目录 mv 进 `.hermit-trash/`，恢复 mv 回来，purge 才 `rm -rf`）——
同一套心智模型，用户不用学第二遍。

**一键的语义 = 一次遍历，每个会话落到「证据支持的最轻档位」**，而不是对所有东西做同一件事。
这条正好回答你的第三个判据：上下文还值钱的归档（随时捞得回来），不值钱的进回收站。

## 判据 #3：上下文还值不值钱

这是唯一一条不能从列上直接算出来的。做法是：**先用结构证据分档，LLM 只做否决**。

倾向**抹除**（留着没意义，下次开新会话完全能接上）：

- `origin = 'dispatch'` —— Brain 的一次性委派，结果早就回传给 Brain 了，**上下文按定义冗余**。全系统最干净的一类。
- **死胎会话**：一条 assistant 消息都没有（spawn 失败 / 开了没用）。
- **空会话**：零用户消息，误点出来的。
- **一问一答**：≤2 轮用户消息 + 自动标题 + 最后一次读之后再没打开过。
- **所属 agent 已在回收站**（`Agent.trashedAt` 非空）—— 纯残渣。

倾向**归档**（留着有意义，但不必占侧栏）：

- `contextTokens` 高（p50 已经 187k，这不是随手聊出来的）
- 消息量大
- 动过文件、跑过 git 提交（content 里有 Write/Edit/Bash 的 `tool_use`）

**LLM 的位置**：只对结构证据判不清的中间地带跑一次批量调用（45 个候选的标题 + preview，一次请求，成本可忽略），
而且**只能把会话往更轻的档位拉，不能往更重的档位推**。它可以说「这个看着还在用，别删」，
不能说「这个我觉得可以删」。误判方向单边安全 —— 这条不对称是整个 LLM 参与的前提。
它顺带产出的一句话理由直接显示在复核面板上。

## 不变式：先睡，后删

唯一一条硬规矩：**绝不删一个 pane 还活着的行。**

抹除因此是异步的，走已有的 tick：

```
1. 打 trashedAt            —— 纯 DB，瞬时，可撤
2. 打 hibernateRequestedAt —— gateway 照常杀 pane（复用现成机制，无新路径）
3. 确认 alive=false 且 pane 已不存在 —— 才真删行 + transcript
```

好处是不用为清理另写一条「删除时顺便杀进程」的路径（那条路径迟早会有分支忘了走）。
**hibernate 成了 delete 的前置条件**，孤儿从结构上就造不出来。

## 一键之后发生什么

你说的是「点击之后自动清理」。可逆的档位确实该直接执行，不可逆的那档不该 ——
所以一次点击分两半：

1. **立即执行**（不问）：把符合条件的会话**睡**掉、**归档**掉。全可逆，出错的代价是「再点一下 reopen」。
2. **弹复核面板**：只列要进**回收站**的，每行一个复选框 + 一句话原因，默认全选；
   底部折叠着「够老但被放过的 N 个 —— 为什么」，把护栏摆到明面上，而不是让你信它。
   三个按钮：`Move N to bin` / `Keep all`（打 `keepAt`，从此不再被提名）/ `Cancel`。
3. **抹除永远不在这次点击里**。回收站里待满 `trashRetainDays` 由 gateway 自己收。

再加两条护栏：

- **爆炸半径上限**：单次点击最多处理 N 个（建议 50），超了分批，面板上写明「本次 50，还有 K 个」。
  静默截断和「已经清完了」长得一样，必须写出来。
- **留痕**：每次清理往通知中心写一条，说明哪几档各动了多少、什么理由。清理本身要可审计。

**自动档**（对齐已有的 `idleReapHours`）：机器级 `cleanupIdleDays`，只跑第 1 步那两个可逆动作。
回收站和抹除永远手动。

## 数据模型

```prisma
model ChatSession {
  // 软删除 / 回收站。非空 = 从所有列表消失，N 天内可恢复，到期由 gateway 抹除。
  // 与 closedAt 的区别：归档是「这事我做完了」，回收站是「这段上下文我不要了」。
  // 照抄 Agent.trashedAt 的形状。
  trashedAt   DateTime?
  // 清理把它放进回收站的理由（'dispatch-done' | 'stillborn' | 'idle-90d' | …）。
  // 回收站里直接显示 —— 判错了要能一眼看出来，而不是事后猜。
  trashReason String?
  // 用户按下「保留」：永不作为清理候选。没有这个字段，同一批会话每次点清理
  // 都会被重新提名一遍，任何周期性清理 UI 都需要一个「别再问我」。
  keepAt      DateTime?
  @@index([machineId, trashedAt])
}

model Machine {
  // 自动清理阈值：闲置超过这么多天的会话自动归档（只做可逆档）。null = 关。
  // 与 idleReapHours 同一个位置、同一种语义。
  cleanupIdleDays Int?
  // 回收站保留天数，到期抹除。
  trashRetainDays Int @default(14)
}
```

`listSessions` / `getSession` / reaper 候选集全部加 `trashedAt: null`。

## Gateway 侧：三个新 tick

**`purgeTick`**（10 min）—— 回收站到期的会话：确认 pane 已死 → 删 transcript → 通知 dashboard 删行。

**`orphanPaneTick`**（10 min）—— 修上面那个 1.54 GB 的洞。
`listSessions('hermit-')`（那个零调用方的现成函数）减去 DB 已知会话的后 12 位，
剩下的就是孤儿；闲置超过阈值（建议 2h，给刚创建还没同步回 DB 的会话留窗口）且 pane 不在干活，就杀。
**这个 tick 独立于清理功能本身有价值**，可以先上。

**transcript：只报数，不清扫。** 实现时发现这一条和 pane 不对称，所以改了方案。

pane 是**可证明属于我们的** —— `hermit-` 前缀是我们自己起的名字。transcript 不是：
`~/.claude/projects` 里躺着这台机器上**所有** claude 用量，而人在终端里手敲的会话，
就落在和 agent 完全相同的按目录分的文件夹里（本来就是在 agent 目录里跑的）。磁盘上没有任何东西能区分两者。

唯一安全的规则 —— 「删我们还握着那一行、且那行指名了它的 transcript」—— **只在行还在的时候成立**，
而那正是 `session-purge.ts` 在抹除时做的事。行没了，证据就没了，独立的 sweep 只能靠猜，
而这里猜错等于删掉用户自己的历史。

所以最终实现是 `collect/transcript-usage.ts`：每天扫一次，算出总量和「没有任何会话指着」的量，
挂在已有的 host-stat tick 上推到 `HostStat`，在清理卡片里显示。**一个字节都不删。**
1.8 GB / 1,923 个文件值得**被看见**，不值得为它上一个启发式。

## UI 落点

- **Settings → System**，`HostHealthView` 下面加一张 `Session cleanup` 卡：
  一行统计（`125 个会话 · 71 个超 7 天未动 · 回收站 3`）、阈值输入框（对齐 `Auto-reap idle >` 的样式）、
  `复核并清理` 按钮。三个孤儿计数（pane / transcript）也放这张卡里 —— 它们是同一类账。
- **侧栏 recents 头部**一把扫帚图标，打开同一个复核面板。清理的痛感发生在侧栏，入口就该在侧栏。
- **回收站视图**：复用 `trashed-agents.tsx` 的形状，列出 `trashedAt` 非空的会话 + 理由 + `恢复` / `立即抹除`。

## 阈值：从实测里挑

按上面的阻断表过滤后，今天这台机器上各阈值的候选量：

| 闲置 > | 候选 | 排除分组/未读/alive 后 | 其中已 hibernated |
|---|---|---|---|
| 7d | 71 | 65 | 32 |
| **14d** | **45** | **45** | 26 |
| 30d | 30 | 30 | 11 |
| 60d | 5 | 5 | 0 |

建议：

- **归档 = 闲置 > 14d** —— 侧栏从 125 收到 80，全可逆。
- **回收站 = 闲置 > 30d 且已归档 且无阻断项 且结构证据判为「上下文不值钱」** ——
  今天大约是 30 个的子集，都要过复核面板。
- **抹除 = 在回收站里待满 14d。**

7d 太紧（65 个里有 32 个还醒着，属于日常节奏内的会话），60d 太松（只够到 5 个，等于没做）。

## 实现（全部已落地）

| 分期 | 落点 |
|---|---|
| 1. 孤儿 pane | `gateway/src/orphan-pane-reaper.ts` + `chat.knownSessions` + `tmux-driver.listSessionsDetailed`；10 min 一跳 |
| 2. 先睡后删 | `trashedAt`/`trashReason`/`keepAt` + `chat.trashSessions`/`restoreSession`/`purgeNow` + `gateway/src/session-purge.ts` |
| 3. 候选 + 复核 + 一键 | `server/session-cleanup.ts`（纯函数 `classifySession`）+ `components/session-cleanup-view.tsx` |
| 4. 自动档 + 留痕 | `Machine.cleanupIdleDays` + `chat.runCleanupSweep`（gateway 每小时）+ `lastCleanupAt`/`lastCleanupSummary` |
| 5. transcript | `gateway/src/collect/transcript-usage.ts` → `HostStat.transcript*`，只报数 |

UI：Settings → System 的 `Session cleanup` 卡（Host health 正下方）+ 侧栏 recents 头部的入口（会话 ≥ 40 才出现）。
侧栏 / 聊天头 / agent 详情里原来的 **Delete 全部改走回收站** —— 它们之前用的是会漏进程的 `deleteSession`。

**LLM 否决层没有做。** 结构证据（dispatch 已完成、死胎、空会话、agent 已删、归档后再静默一个月）
已经把候选集收得足够干净，而复核面板本来就要人看一眼 —— 在人眼前面再插一个会犯错的判官，
增加的是延迟和不可解释性，不是安全性。真需要时它的位置已经留好：只能降档，不能升档。

## 测试

- `server/session-cleanup.test.ts` —— 23 条，每个阻断项一条。写法是「什么会让它删掉不该删的」，不是走 happy path：
  阻断项失效不会抛错、不会打日志，只会安静地开始提名有人依赖的会话。
- `gateway/src/orphan-pane-reaper.test.ts` —— 7 条。这是全功能里唯一会**无痕杀掉活进程**的函数，
  所以 `selectOrphanPanes` 被抽成纯函数单独测：空 known-set、刚建的 pane、pane 名推导漂移，三种「会误杀」的路径各一条。
- `gateway/src/session-purge.test.ts` —— 6 条，全部关于**拒绝**删 transcript。
- 一次性的真库端到端（postgres 17 临时实例，17 个用例全过，未提交 —— 仓库的 test runner 没有 DB fixture）。

**端到端跑出来一个单测抓不到的真 bug**：`dispatchedBySessionId` 在 dispatch 子会话的**整个生命周期**都非空
（watcher 靠它找 Brain），所以把它无条件当阻断项，会让下面 `dispatch-done` 那条规则**永远不可达** ——
全功能最有价值的一类候选变成了死代码。修法是用 `closedAt` 当完成线：在飞的 dispatch 才 pin 住会话。
同一个原因，poke-target 查询也加了 `closedAt: null`，否则一个 Brain 会话会被它几个月前发出的委派永久钉住。

## 不做

- **跨机器清理**。清理按 `ctx.machine.id` 严格分机器 —— 一个按钮悄悄扫掉另一台机器的会话是不可接受的。
- **按体积清理**（「先删最大的」）。体积和价值不相关，p90 那个 683k token 的会话很可能正是最该留的。
- **消息级清理**（只删某个会话里的 tool_result 块）。省得多，但会把一段对话变成半真半假的记录，
  和「清理」是两件事，另开。
