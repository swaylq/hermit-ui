# 灵动岛 / 锁屏实时活动 — 设计

2026-09-04 · apps/ios + apps/dashboard

## 目标

手机锁着的时候，看一眼就知道**这个会话现在怎么样**：它在跑还是在等你、它正在干什么、
已经多久了。这是网页在 iOS 上做不到的一类事——WKWebView 里没有任何 API 能在锁屏上画东西。

**关键约束**：一个只有 App 自己能更新的实时活动，在你放下手机的那一刻就冻住了，
而那正是锁屏组件唯一有用的时刻。所以本方案的重点不是「画出来」，而是**让服务端推着它走**。

## 显示什么，以及为什么是这些

四件事，按「站在锁屏前一秒钟内需要判断什么」排序：

1. **它在等你吗**（`blocked`）—— 唯一用橙色、唯一会震动提示、唯一带「去回答」按钮的状态。
2. **哪个会话** —— agent 名字；只有当这台设备接了不止一个部署时才显示机器名，
   否则那是个常量，常量在锁屏上是要反复跳过的噪声。
3. **正在干什么** —— 网关已经在产出的那条 activity 文案（`Bash · pnpm build`、`子 agent：…`）。
4. **多久了** —— 系统计时器。

越小的呈现回答越少的问题：`minimal` 只回答第 1 条，`compact` 加第 4 条，
展开态和锁屏横幅回答全部。

**没有放进去的东西**：回合结束时的回复正文。同一轮的普通推送通知已经带了 140 字，
锁屏上同一句话出现两次没有意义。结束时显示的是**这一轮跑了多久**——那个数字别处没有。

## 颜色和图标：一律取自网页端，这里不做选择

第一版我在这里自己挑了一套色（working 用青色），是错的：产品里不存在那个颜色，
而且和蟹壳的暖橙撞。`apps/dashboard/src/lib/session-status.ts` 顶部有 sway 写的状态色谱，
聊天页头部、侧栏圆点、agent 详情面板都读它，就是为了不互相飘。锁屏再飘一次没有道理。

映射（Tailwind 类名 → 状态）：

| 灵动岛状态 | 取的色 | 理由 |
|---|---|---|
| working / blocked | `amber-400` | **同一个色**。网页规范原文：「和 working 同色（会话正在回合中），但它是对着你闪，不是替你闪」——区分靠的是**脉冲**。灵动岛没法脉冲（那要每帧一次推送），所以差别改由这个媒介有的通道承担：图标上的手势徽标、「去回答」按钮、alert、以及把 blocked 的 `relevanceScore` 提到最前 |
| done | `rose-500` | 不是绿色。回合刚结束、你还没看，在这个产品的词汇里就是 **unread**，而 unread 是红的（「上一个对话的任务都处理完了，等待阅读」） |
| failed | `zinc-400` | 进程没了就是 down |

**色值必须转，不能抄记忆里的十六进制。** Tailwind 4 用 OKLCH 定义调色板，其中三个色超出
sRGB 色域；转成 sRGB 会被裁（amber-400 落到 `#FFB900`，红蓝两个通道都顶到边界），
在同一台手机上看明显比 Safari 里那个平。所以代码里写的是 **Display P3** 分量
（`apps/ios/Shared/StatusPalette.swift`）。顺带一提 amber-400 在 Tailwind 3 是 `#FBBF24`，
现在已经不是了——凭印象写会错。

**图标就是那只蟹。** 灵动岛的紧凑态和最小态放 `logo-crab-mono.png`——和 dashboard 里到处用、
靠 CSS 染色的**同一份文件**（sha256 一致），以 template 图片导入，所以在这边同样吃
`foregroundStyle`。App 图标那张不能用：它是带背景的全彩位图，而这个位置要的恰恰是一个
能被状态染色的 mark。

## 架构

```
App（前台，知道回合开始）           服务端（持有 activity 的 push token）
  Activity.request(pushType:.token)
        │ token
        ▼
  NativeBridge → 网页层 → push.registerLiveActivity  ──▶  LiveActivity 表
                                                              │
  网关 8s 快照 / turn 边界(~150ms) ──▶ /api/sync/session-snapshot
                                          │ 写库后
                                          ▼
                                    syncSessionActivity()
                                          │ 内容变了才发
                                          ▼
                                    APNs liveactivity ──▶ 锁屏 / 灵动岛
```

**壳仍然不持有任何凭据。** activity 的 push token 由原生拿到、交给网页层，
网页层用它已有的机器密钥去注册——和 APNs 设备令牌一模一样的安排，理由也一样。

## 展开态的排布，和怎么在没有真机时看它

第一版把会话标题放在展开态的**中间区**——那是两根窄柱之间、摄像头挖孔底下的那条缝，
结果标题被夹得局促、像第三根柱子在跟两边抢位置，而下方整条通栏只放了一个词、空一大片。

现在中间区**空着不用**，内容集中到通栏：

```
🦀 asst              ⟨挖孔⟩              0:09     ← 谁 / 多久，一边一个事实
─────────────────────────────────────────────
Bash · pnpm --filter dashboard build            ← 在干什么，给足宽度
Hermit UI 实时预览          排队 2   ctx ▇▇░ 41%  ← 哪个会话 / 队列 / 上下文
[            去回答            ]                 ← 只在等人时出现
```

**上下文用的是侧栏那一档，不是聊天头部那一档。** `components/ctx-bar.tsx` 有三种粒度，
这里取 `compact`（只有百分比和条，没有 token 数）。不是为了省地方：token 数每隔几秒就变一次，
而每变一次就是一次 APNs 推送；整数百分比一辈子最多变一百次。阈值和配色照抄——
≥90% 玫红、≥70% 琥珀、其余绿，条用 500、数字用 400。没有完成过回合时显示 `ctx —`，
遵守「ctx 占比任何状态都要显示」。

**等人时那行写的是它到底在问什么**，不是「等你回答」——状态已经由颜色、手势徽标和按钮说了三遍。
权限请求渲染成 `要用 Bash：rm -rf /tmp/x`（参数按 `message-digest.ts` 的 `PREVIEW_KEYS`
顺序挑，和时间线里那张折叠卡片挑的是同一个键），提问就直接显示问题原文。

### 看得见，才能改得对

`ActivityViewContext` 没有公开构造器，所以依赖它的视图**只能靠打包、签名、装机、跑一个真实回合**
才看得到——第一版排版之所以难看，就是这么来的。

现在呈现层写在 `LiveActivity/SessionCardViews.swift`，只吃一个普通的 `SessionCard`，
不 import ActivityKit 也不 import WidgetKit；WidgetKit 那层薄壳在
`SessionActivityViews.swift`，只负责把 context 转成 card。于是：

```bash
apps/ios/tools/render-cards.sh          # 输出到 $TMPDIR/hermit-cards
```

把同一份视图编成 macOS 程序、用 `ImageRenderer` 画成 PNG，五个状态各一张。
几何是近似的（真实挖孔布局的尺寸不公开），但它能验的正是第一版错的那部分：层级、间距、
有没有东西被挤扁或被孤零零扔在角落。蟹的图从 environment 注入（`\.crabImage`），
所以这个工具不需要资源目录也不需要改任何生产代码。

## 三条硬规则

1. **不要发经过的时间。** 组件用一个起始时间戳自己画计时器，系统每秒重绘，不花任何推送。
   把时长放进载荷意味着每秒一次推送，而 Apple 对高频活动更新有预算，超了直接丢。
   `session-state-push.ts` 的签名排除 `elapsedSec` 就是同一个道理。
2. **只在内容变化时推。** 网关每 8 秒写一次快照，绝大多数在说同一件事。
   签名是 `phase|title|line|queued`——一个人能看出区别的字段，没有时间戳。
3. **不要走 `enqueuePush`。** 那条管线的 20 秒去抖和 `turnStillRunning` 闸门的设计目的
   就是「别在回合中途打扰人」，而实时活动要的恰恰全是中途状态。
   所以它挂在快照写库之后，和那套机制完全不共用。

## 载荷契约（最容易静默出错的地方）

`content-state` 必须和 `apps/ios/Shared/SessionActivityAttributes.swift` 的
`ContentState` 逐字段对上。字段名对不上时，**APNs 返回 200、整条更新消失、任何日志里都没有痕迹**。

时间用 **Unix 秒**，且在 Swift 侧显式声明成 `Double` 而不是 `Date`。
原因：这个结构会被两个解码器读——App 内 ActivityKit 用 Swift 自己的编码器（`Date` 是 2001 纪元），
而服务端的 `content-state` 是手写 JSON。两者对一个裸数字的理解相差 31 年，且不报任何错，
计时器只会显示一个错误的数字。

## 更新策略

| 情况 | 优先级 | 说明 |
|---|---|---|
| 工具切换、后台任务变化 | 5 | 让系统攒着发，省预算 |
| 变成 `blocked` | 10 + alert | 唯一值得打断人的转变 |
| 回合结束 | 10，`event: end` | 停留 5 分钟后自动收起 |

`stale-date`：working 15 分钟（长工具调用本来就可能很久没有变化，这里要抓的是网关死了，
不是 Bash 在思考），blocked 6 小时（等人是个能持续几小时的**静态事实**，把它变灰是在撒谎），
结束态不设。

同一会话两次更新之间有 2 秒下限，但 `blocked` 和结束这两个转变豁免——那是人真正在等的两件事。

## 没做的部分

- **push-to-start**（iOS 17.2+，让服务端在 App 没运行时**拉起**一个活动）。
  token 已经在收集和注册了（`PushDevice.liveActivityStartToken`），
  所以服务端将来加这条路不需要重新发版；但当前版本不用它，活动只能由前台的 App 起。
- **多会话** —— 一次只跟当前打开的那个会话。系统本身支持同时展示多个，
  `relevanceScore` 也已经按「等人 > 在跑」排了序。

## 部署需要做的两件事

1. **跑迁移** `prisma/migrations/20260904070000_live_activity`（新表 `LiveActivity` +
   `PushDevice.liveActivityStartToken` 一列）。**本机没有数据库，这个迁移没有被执行过。**
2. APNs 那边不需要新凭据——同一个 `.p8`、同一个 team。但 topic 变了：
   实时活动用 `<bundleId>.push-type.liveactivity`，发成裸 bundle id 会被拒绝，
   错误是 `TopicDisallowed`（读起来像是描述文件配错了）。

## 验证状态

已验证：Swift 对 iPhoneOS26.5 SDK 类型检查与真实构建（0 警告），
扩展正确嵌入 `Hermit.app/PlugIns/HermitLiveActivity.appex`，
`smoke.sh` 在模拟器 iPhone 17 上启动无崩溃、收尾干净，
dashboard `tsc --noEmit` 全绿、改动文件零新增 lint 问题。

**未验证，且只有真机加一次真实回合能验**：
锁屏和灵动岛的实际排版、APNs `liveactivity` 那条推送是否真的到达并被解码、
以及 `content-state` 的字段是否真的对上——最后这条正是本文档反复强调的静默失败点。
