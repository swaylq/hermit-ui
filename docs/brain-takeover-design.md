# 义脑接管 + 用户画像 — 设计

**Goal:** 两件事。① 任何一个对话都可以交给义脑接管，由它替你继续和那个 agent 对话，直到把你想做的事推完。② 义脑维护一份对**你**的读解（`USER-PROFILE.md`）——你怎么做决定、怎么说话、在做什么——从你真正打过的字里总结，每晚做梦时刷新。

**Non-goals(v1):** 义脑自己发起接管（永远由人交出）、跨机器接管、接管别人分享给你的 agent、在接管里改 PERSONA、把画像做成结构化字段（它就是一份 markdown）。

---

## 一个前提发现

`dispatch_result` 现在并不检查 `origin === 'dispatch'`，它拿 sessionId 直接读 `chat.listMessages`（`mcp-stub.cjs:525`）。所以「义脑读写一个已有会话」技术上已经通了。真正缺的是四样：**会话上的接管状态**、**消息作者标记**、**watcher 认得接管会话**、**止损**。

## 两个功能之间的隐藏依赖

`ChatMessage.role='user'` 现在分不出是人打的还是机器写的。dispatch 会话能靠 `ChatSession.origin` 整段排掉，但接管发生在**普通会话**里——义脑的话会混进你的消息流。

于是功能二的语料就不干净了：义脑会把自己说的话当成你的偏好去学，学完再照着行动，下一轮再学一遍自己。这个漂移**不会报错**，只会让它慢慢变成一张自画像。

所以 `ChatMessage.authoredBy` 是整个设计的地基，两个功能必须同一批上线。先上接管后上标记的话，中间那段时间产生的消息事后永远分不出来。

顺带修了一个既有的同类问题：网关两个 watcher 往义脑会话插的 `[dispatch update]` 也是 `role='user'`，以前没有标记，同样会被当成人类语料。现在统一走 `pokeSession()` 打 `authoredBy:'system'`。

---

## 架构

```
你 ──「接管」──▶ chat.requestTakeover
                    │  写 takeoverBySessionId（= 义脑会话 id，兼作标志位）
                    │  往对话里写一条 system 行
                    └─ poke 义脑："去读 session X，推断目标，然后驱动它"

义脑 ──takeover_read──▶ 读对话（每条带 who: human / you / system）
     ──takeover_say───▶ chat.send({authoredBy:'brain', goal})
     ──dispatch_answer▶ 解开 agent 卡住的选择（安全底线原样适用）
     ──takeover_release▶ 交还 + 总结

网关 runTakeoverWatch（8s）
     └─ 算签名（blocked / done），变化时 poke 义脑

你打字 ──▶ chat.send（无 authoredBy）──▶ 立即结束接管
```

## 数据模型

`ChatSession` 加 5 列，形状照抄现有的 dispatch 那套：

```prisma
takeoverBySessionId String?    // 义脑会话 id；非 null 即「接管中」
takeoverStartedAt   DateTime?
takeoverTurns       Int @default(0)
takeoverGoal        String?    // 它推断的目标，直接显示给你
takeoverNotify      String?    // watcher 去重签名，同 dispatchNotify
```

`ChatMessage` 加 1 列：

```prisma
authoredBy String?   // null = 你打的；'brain' = 义脑；'system' = 网关 poke
```

存量行全是 `NULL`（视为人类）——正确，因为接管在这条 migration 之前不存在。

两条索引：`takeoverBySessionId` 的部分索引给 watcher 轮询；`(createdAt) WHERE role='user' AND authoredBy IS NULL` 的部分索引给画像的增量扫描（人类消息在参考机器上约占 19 万条里的 1%，所以这个索引很小）。

## 止损：只保留有意义的那几个

**接管不设时长和轮数上限**（2026-07-28 起）。原来有 12 条 / 30 分钟两道闸，实测是错的形状：它们在活儿干到一半时触发，把没做完的工作交还回来——而那正是这个功能存在的目的所要避免的打断。

留下的终止条件都是有含义的：

- 义脑判断达成，主动 `takeover_release`
- 义脑撞上安全底线，需要只有你能做的决定
- **你打字，或点 Release** —— 立即生效，也正是其余部分可以无限的原因：你永远离「收回」只有一个按键
- 会话被关闭

**为什么这样不会跑飞**：不是靠计数器，是靠循环的形状。义脑只在**agent 真的产出了东西**时被唤醒（watcher 只在真实状态跃迁时 poke，从不定时触发），所以它无法自己空转。义脑和 agent 来回打转属于判断失误，`takeover` skill 里点名了这种情况。

**唯一保留的数字是并发数**（`TAKEOVER_CONCURRENCY`，现为 8）。它**不是**对义脑干多久多狠的限制，而是资源闸：每个接管持有一个自己的义脑会话，也就是一个活的 claude 进程，而这台机器有 OOM 前科。可以随便调高，它只是防止一次性交出太多把宿主打垮。

**你打字即收回**：`chat.send` 收到没有 `authoredBy` 的消息且接管中，立刻 `endTakeover(reason:'human')`。伸手就是意图，不该先让你找按钮——否则你的消息会落在接管中间，和义脑的下一条抢。

接管的开始和结束都往对话里写 **system 行**，不是 toast。「这个决定是谁在开车时做的」是下周还该看得见的东西。

## 目标由义脑推断

你不用输入任何东西。义脑读完对话自己归纳，并在**第一条消息**里必须带上 `goal`——它立刻显示在输入框上方的横幅里。

这是设计里最脆的一环（零输入的代价），缓解方式不是让它推得更准，而是**让推错变便宜**：目标就摆在你眼前，错了你瞄一眼就收回，代价是一条消息而不是十二条。

## MCP 工具（brain-gated）

| 工具 | 作用 |
|---|---|
| `takeover_list` | 我在驱动哪些对话：目标、已用轮数、working |
| `takeover_read` | 读对话，每条带 `who`（human / you / system） |
| `takeover_say` | 以义脑身份发言，第一条必须带 `goal` |
| `takeover_release` | 交还 + 总结 |
| `user_messages` | 人类打过的字（画像语料），带 `since` 水位线 |

解块**复用 `dispatch_answer`**，只放宽了描述。

---

## USER-PROFILE.md — 它学到的你

### 为什么不写进 PERSONA.md

`PERSONA.md` 是 write-once 种子，之后**完全归你**（`brain-template.ts` 里明写「it's yours, not machine-managed」，版本升级都不覆盖）。而画像是机器每天重写的。两者放一个文件，就是「我改的字被吃了」的标准配方。

所以分成两个文件，`/brain/persona` 页面并排展示：左边 Persona（可编辑，你的）、右边 What it's learned about you（只读 + Regenerate）。

右边**故意只读**：义脑每晚重写这个文件，输入框会是一个系统兑现不了的承诺。写错了该去跟义脑说，而不是去改它的笔记。

### 语料：四层过滤

```
role = 'user'          — assistant/tool/system 不是人
authoredBy IS NULL     — 排掉义脑接管的话 + 网关的 poke
session.origin IS NULL — 排掉整个 dispatch 会话
externalId IS NULL     — 排掉网关同步回来的 transcript 行
                         （tool_result、agent 中途 Read 的图片，在 Anthropic
                          格式里也是 role='user' —— 和 USER_QUEUE_FILTER 防的是同一个坑）
```

四层里有三层互相冗余。这是故意的：每一层单独都有失效场景，而语料泄漏是无声的——等你发现时义脑的行为已经漂了。这也是 `corpusQuery` 被抽成纯函数单独测的原因。

### 增量：水位线在文件里

义脑把 `<!-- synced-through: <iso> -->` 写在 `USER-PROFILE.md` 末尾，下次只拉之后的新消息，**折进已有内容而不是重写**。服务端因此完全无状态，没有 DB↔文件的同步可漂。

和会话自动标题那套是同一个模式（`titleMsgCount` 水位线 + 「延展而不是替换」）。

一次调用有上限（400 条），义脑在做梦时循环拉到空为止——积压被逐步吸收，而不是被截断成「最近 N 条」。

### 什么时候跑

挂进**已有的 Daily dream cron**（`dreaming` skill 第 7 步），加面板上的 Regenerate 手动触发。**不新增任何轮询。**

---

## Brain 模板 v6

- 新增 managed skill `takeover`（驱动别人对话的完整生命周期）
- 新增 write-once 种子 `USER-PROFILE.md`
- `dreaming` skill 加第 7 步「Read the human」
- `dispatching` skill + IDENTITY 改成读两个文件，并明确 **`USER-PROFILE.md` 同样不能松动安全底线**——「他这种事一般都批」不是批准权

⚠️ 网关的 overlay 白名单（`agent-lifecycle.ts`）是**静默过滤**：不在名单上的路径被无声跳过。加种子文件必须同时加白名单，`USER-PROFILE.md` 已加。

---

## 验证

| 层 | 手段 | 结果 |
|---|---|---|
| 上限边界 | 纯函数单测（正好撞线、超线、两条同时撞、缺 startedAt） | ✅ |
| 语料过滤 | `corpusQuery` 四层守卫 + 水位线 + 截断边界单测 | ✅ |
| 全仓测试 | `npm test` | ✅ 113 通过 |
| 类型 | dashboard + gateway `tsc --noEmit` | ✅ |
| lint | 改动文件 | ✅ 无新增（既有 36 条改前改后一致） |
| MCP stub | `node --check` | ✅ |
| 构建 | `next build` | ⚠️ compile 通过；**静态预渲染步骤失败** |
| 真实接管 | 端到端 | ⬜ 未做 |

### 构建那条要说清楚

`next build` 的 compile 阶段通过，但静态导出阶段报
`Invariant: Cannot access "entryCSSFiles" without a work store. This is a bug in Next.js.`

这**不是本次改动引入的**，证据是：在主工作树、`feat/ios-shell` 分支（不含本次任何改动）上连跑三次同样失败，且每次挂的页面都不同（`/brain`、`/brain/memory`、`/brain/persona`、`/_global-error`、`/_not-found`）。页面随机 + Next 自称 invariant bug = 导出 worker 的不确定性故障。

但它确实是**新出现的**：今天早些时候同一棵树构建是通过的。谁动了相关依赖或配置值得单独查一次，在那之前**部署前必须确认这条**——本设计只能保证不是自己引入的。

### 端到端没做

真接管一次（推目标 → 驱动几轮 → 交还）、撞上限强制交还、做一次梦看 `USER-PROFILE.md` 只吃到人类消息——这三样都需要活的义脑 + 真 agent，没做。逻辑正确和编译通过不等于跑得通。

---

## 风险

1. **推断目标是最脆的一环**。零输入是你选的，缓解靠「目标可见 + 伸手即收回」，不靠更聪明的推断。
2. **`authoredBy` 必须和接管同批上线**，否则中间产生的消息永久无法归属。
3. **义脑代你答块**时最容易越界——它站在你的对话里，很容易「像你一样」批准。skill 里为此单独写了一段：被交出方向盘不等于被交出授权。
