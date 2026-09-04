# Hermit iOS 原生化 — 设计

2026-09-04 · 三个前置决定 sway 已答复（见第五节），可以开工

**Goal:** 让 iPhone 上的 Hermit 具备套壳做不到的事 —— 冷启动就能读、断网也能发、
凭据不会被清掉 —— 同时**不**把变化最快的那部分代码搬进发布最慢的那一端。

**Non-goals:** 全原生重写；把 dashboard 剩下 31 个页面搬到 Swift；Android；Apple Watch；
iPad 专门排版。这份文档明确推翻 `docs/ios-shell-design.md:5` 里「原生 UI」这条 non-goal，
但只推翻其中很小的一块，理由见第一节。

## 一句话结论

不要全原生。分三段，前两段值得马上做，第三段设一道闸门：

| | 做什么 | 大概多少 Swift | 卡在什么上 |
|---|---|---|---|
| **第一段** 能力交接 | 桥加问答通道、密钥进 Keychain、离线发件箱 | ~600 行 | 只剩 `chat.send` 加幂等键（服务端，半天） |
| **第二段** 换掉前门 | 原生导航容器 + 原生会话列表 + origin 可改 | ~900 行（卡片视图已有） | 第一段 |
| **第三段** 时间线 | chat 那一屏做成原生 | 数千行，且要永远跟着改 | 三条闸门条件，现在**一条都不满足** |

第三段现在不做。前两段做完，App 的界面只多一屏，但冷启动、断网、清存储这三种情况的
行为完全变了。

**插队一件事**：sway 已确认 `dash.swaylab.ai` 后续会并到 `hermit`。App 的 origin 今天是
编译期常量，而麦克风授权按 origin 精确比对 host —— 迁移当天不改这里，这个 App 存在的
唯一理由就没了。所以「origin 可改」不是第二段的搭头，是要**先于迁移**落地的一件事，
详见第五节决定三。

---

## 一、决定范围的那个数字

近 90 天，同一个仓库：

| 区域 | 提交 | 当前行数 |
|---|---|---|
| `apps/dashboard`（整个网页端） | 619 | 46,816 行 TS/TSX（`app` + `components` + `lib`） |
| chat 一条路径（`app/chat` + `components/chat` + `lib/chat-cache`） | 264 | 17,546 行 |
| **`apps/ios`** | **15** | **2,524 行 Swift** |

网页端的提交速度是 iOS 壳的 **41 倍**，而 chat 那一条路径独自吸收了其中的 43%。

这不是抽象的担心，已经发生过一次：壳在 2026-07-26 建好之后，到 2026-09-02 才有下一个
提交，**中间 5 周网页端合了 265 个提交**（chat 路径 148 个）。`3808dc5a` 的提交说明
写的就是这件事的后果 —— 网页端整套 iOS 适配都写在 `@media (display-mode: standalone)`
里，而 WKWebView 报的是 `browser`，于是那些适配在它们本来要服务的这个 App 里**整套
静默失效了一个月**：顶栏钻进刘海、键盘盖住输入框、`/push` 页叫一个已经在 App 里的人
去「添加到主屏幕」。没有任何一处报错。

所以本文的第一条设计约束不是技术选型，是**分界线画在哪**：

> 变得慢、且属于设备而不属于产品的东西 → 搬进原生。
> 变得快、且决定「一条消息长什么样」的东西 → 留在网页。

下面每一段的取舍都从这一条推出来。

---

## 二、今天的壳有什么（2,524 行，零第三方依赖）

- **根视图控制器就是 `WebViewController` 本身**（`SceneDelegate.swift:10-14`），没有
  `UINavigationController`，没有 tab bar，没有原生导航。全部路由由 WebView 里的
  Next router 完成。
- **没有任何原生网络层。** 全仓 `URLSession` 零处，Keychain 零处，本地数据库零处。
  唯一的 `URLRequest` 是 `webView.load`。
- **桥是单向 fire-and-forget**（`NativeBridge.swift:150-189`）：10 种 web→native 消息、
  5 个 native→web 函数，**没有 request id，没有回调配对**，所以今天的桥无法承载
  「原生问网页要一份数据」。
- **壳不持有任何凭据** —— 这条写在 6 处（`apps/ios/README.md:109`、`NativeBridge.swift:6`、
  `LiveActivityManager.swift:19`、`HermitLiveActivityBundle.swift:6`、`AppConfig.swift:26`、
  `native-bridge.ts:5`）。第五节会论证为什么它必须改。
- **只能连一个部署**：`AppConfig.origin` 是 `static let`，硬编码 `https://dash.swaylab.ai`
  （`AppConfig.swift:8,16-22`），只有 `smoke.sh` 用启动参数覆盖过。
  `hermit.zhinan.tech` 上的机器今天**根本没有 iOS App 可用**。
- **已经在用的原生资产**：`Shared/SessionCard.swift`（45 行，纯视图模型）+
  `Shared/StatusPalette.swift`（69 行，从 `lib/session-status.ts` 和 `ctx-bar.tsx` 逐值
  抄来的颜色）+ `LiveActivity/SessionCardViews.swift`（364 行 SwiftUI，**只 import
  SwiftUI**，所以 `tools/render-cards.sh` 能把它编成 macOS 程序渲染成 PNG）。
  这三个文件是本文第二段方案能便宜的全部原因。

`apps/ios/README.md:15-19` 已经自己承认：Web Push 和 Bark 落地之后，**推送不再是这个
App 存在的理由，麦克风是唯一剩下的那个**。本文要回答的正是「除了麦克风，还有什么值得」。

---

## 三、原生真正能买到的东西（四样，其余是错觉）

**① 冷启动直接有内容。** 今天每次冷启动都是「白屏 → 加载 Next → 网页拿 keyring →
发第一个 tRPC 请求 → 画列表」。原生把会话列表从本地快照画出来是 100ms 量级的事，
网络回来再更新。这一条对「掏出手机看一眼 agent 卡住没有」的用法影响最大。

**② 断网能发出去。** 今天没有出站队列：`app/chat/page.tsx` 的 `onError` 只做两件事 ——
删掉乐观气泡、把文本塞回 `localStorage['hermit:draft:<sid>']`。没有重试、没有退避，
全仓 `navigator.onLine` 零命中。断网发消息就是失败，人得自己再点一次。服务端那个
「队列」是另一回事（`deliveredAt = null` 的行），它管的是 agent 忙时排队，不管网络。

**③ 凭据不会被清掉。** 机器密钥今天在 `localStorage['asst-dashboard-keyring']`
（`keyring.ts:22`）。WebView 的存储被系统回收或被人清一次，全部机器一起掉线，要重新
一台台输密钥。Keychain 不会。

**④ 列表滚动交给系统。** 这一条有实数支撑：`components/chat/` 下专门为「让列表在移动端
WebKit 里正确滚动」写的基建有 **3,353 行**（另加 1,428 行测试）——
`use-timeline-window` / `timeline-window`（窗口化）、`use-scroll-stability` /
`scroll-stability-core`（写 `scrollTop` 的节流与结算）、`use-prepend-anchor` /
`prepend-anchor-core` / `use-anchored-window`（往上加载历史时的锚定）。
它从 2026-07-27 开始写，近 90 天 27 个提交，**其中 23 个在最近 30 天** —— 还没收敛。

`docs/mobile-scroll-momentum-design.md` 记了根因：iOS 的滚动跑在引擎之外的
UIScrollView 上，**给 `scrollTop` 赋值等同 `setContentOffset`，会终止惯性滚动**。
线上实测一次 5,000px 的平滑滚动只走了 2,785px 就停死，随后 93 个连续帧写 `scrollTop`
且每次实际位移 0px。为了绕开它，仓库自己实现了 react-virtuoso 那套 deviation（把修正
付给一个负 `margin-top`，滚动停下再解开）。

UIKit 这一层是平台自带的：`UICollectionViewLayoutInvalidationContext.contentOffsetAdjustment`
在布局阶段调整偏移，不经过 `setContentOffset`，所以惯性不断；cell 复用让窗口化整个消失。
**不是说原生没有这类问题**（自适应高度的 cell 配上往前插入，UIKit 里同样难缠），
区别在于难的那一半由 Apple 维护了十五年，而不是我们自己 3,353 行、每月还在改 23 次。

**不值得为它做原生的**（列在这里免得以后再讨论）：推送（Web Push + Bark 已覆盖，
README 自己说的）；灵动岛（已经是原生了）；后台常驻 SSE（iOS 挂起 App 时一样断，
真正的后台送达靠推送，而推送已经有了）；表单页（见第七节）。

---

## 四、分三段，每段有自己的退出条件

三段之间是**能力依赖**，不是排期。第一段不改任何一个像素，第二段才第一次出现原生界面，
第三段有一道明确的闸门，条件不满足就不做。

### 第一段：能力交接（页面一个像素都不改）

三件事，全部在桥和 Swift 里，网页端只改三处调用点。做完之后 App 看起来完全一样，
但冷启动、断网、清存储这三种情况的行为变了。

**A0 — 先给桥加上「问答」通道。** 今天的桥是单向广播：`NativeBridge.swift:150-189`
的 switch 收 10 种消息，没有 request id，没有回调配对，所以原生**问不了网页要东西**，
网页也**等不到原生的回答**。后面所有事都卡在这一条上，它必须先做。

```
web → native   { type: 'req', id: '<uuid>', method: 'keychain.get', params: {...} }
native → web   window.__hermitNative.onReply(id, ok, payload)
```

`id` 由发起方生成，接收方原样回传；超时由发起方管（原生 5 秒，网页 5 秒）。
`NativeApi`（`native-bridge.ts:28-34`）加一个 `onReply`，Swift 侧加一张
`[String: (Bool, Any?) -> Void]` 的待答表。约 60 行 Swift + 40 行 TS。

**A1 — 机器密钥搬进 Keychain。** 今天 keyring 在
`localStorage['asst-dashboard-keyring']`（`keyring.ts:22`），选中项在 sessionStorage。
WebView 的存储被系统回收、或谁清了一次网站数据，几台机器一起掉线。

- 接缝只有两个函数：`keyring.ts:29`（读）和 `:36`（写）。在壳里改走
  `keychain.get` / `keychain.set`，其余调用方一行不动。
- Keychain 属性：`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`（锁屏后
  通知扩展也读得到，但不跟 iCloud 同步、不进备份）；放在 App Group 容器里，
  第二段的原生列表和通知扩展共用同一份。
- 迁移只做一次：首次升级后网页把现有 keyring 交给原生 → 原生写入并**读回校验** →
  校验通过才清 localStorage。顺序反了就会丢钥匙串。
- 退出登录必须连带清 Keychain，否则「清掉网站数据」不再等于登出。

**A2 — 出站队列（断网也能发）。** 今天没有：`app/chat/page.tsx` 的 `onError` 只删掉
乐观气泡、把文本塞回 `localStorage['hermit:draft:<sid>']`，没有重试也没有退避，
全仓 `navigator.onLine` 零命中。

- 壳里发送改成一次桥调用：`{ type:'req', method:'outbox.enqueue', params:{ clientId,
  sessionId, text, images, files } }`。原生落盘（App Group 里一个 append-only 的
  JSON 行文件就够，不需要数据库）后立即尝试，结果通过 `onReply` 回给网页，
  乐观气泡照旧由网页画。
- 重试时机：`NWPathMonitor` 报网络恢复、App 回前台、以及一个 `BGAppRefreshTask`。
  **要说实话**：iOS 不会在 App 被杀之后跑我们的代码，所以这里的保证是「关掉 App
  再打开，消息还在并且会自己发出去」，不是「躺在口袋里几秒内送达」。
- **这一段有一处服务端改动，绕不过去**：`chat.send`（`chat.ts:1121`）今天**没有
  幂等键**（输入只有 `sessionId` / `text` / `images` / `files`）。重试队列最典型的
  场景就是「服务端写成功了、响应在半路丢了」，没有幂等键这时会发出第二条一样的消息。
  需要给 `send` 加一个可选 `clientId`，在 `ChatMessage` 上加
  `@@unique([sessionId, clientId])`，重复请求返回已存在的那一行。
  没有这个改动，出站队列会**制造**它本来要解决的那类问题。

**A3（可做可不做）— 通知扩展预取。** 加一个 Notification Service Extension，
收到推送时用 Keychain 里的密钥拉一次新消息写进 App Group，打开 App 时会话已经是新的。
推送 payload 要带 `mutable-content: 1`。扩展只有约 30 秒，所以只拉当前会话最近一页。
它的价值取决于第二段做不做原生列表 —— 单独做收益有限。

**这一段的退出条件**：拔掉网线能把消息排进队列、恢复网络后自动发出且不重复；
在系统设置里清掉 App 的网站数据后，重开仍然是登录态。

---

### 第二段：换掉前门，而不是搬走页面

直觉的做法是「先挑几个又小又稳的页面做成原生练手」。**那个做法是错的**，
下面这组数字是推翻它的理由。

把 32 个页面按「自己的代码」和「它拖进来的共享代码」分开数，结论是反直觉的：
一个典型的设置页自己只有 33–1,084 行，但它背后的共享外壳（侧栏 4,258 行 +
真正被用到的 `components/ui` 约 1,400 行）是 **6,800–8,000 行**，中位数约 7,100。
也就是说，**一个设置页背后约 95% 的代码是外壳，不是这个页面**。`/watchdogs` 是
310 行自己的代码坐在 7,057 行共享代码上；`/trash` 是 15 行坐在 6,945 行上。

更糟的是这层外壳自己也在快跑：`components/sidebar/**` 加 `app-sidebar.tsx` 近 90 天
144 个提交、净增 2,690 行，是全仓第二热的区域（仅次于 chat）。

所以「先做几个便宜页面」实际上是「先付 5,700 行的外壳税，再去省 200 行」。

**正确的做法是不要移植那层外壳，而是用系统自带的替掉它。** 手机上不需要一个抽屉式
侧栏，需要的是一个列表加一个返回按钮：

```
UIWindow
└── UINavigationController                        ← 新增，替换 SceneDelegate.swift:10-14
    ├── SessionListViewController （原生）          ← 前门
    └── push → WebViewController(/chat?session=…)   ← 现在的那个壳，原样复用
```

- **根视图从 `WebViewController` 换成导航控制器**。同一个文件里另有三处硬假设要一起改，
  都在 `SceneDelegate.swift`：`:18` 把控制器交给 `AppDelegate.attach`，
  `:39` 和 `:49` 都是 `window?.rootViewController as? WebViewController` 的强转
  （深链接和释放音频会话）。套上导航控制器之后这三处会静默失效 —— 强转返回 nil，
  不报错，只是深链接不跳、音频会话不放。
- **前门是原生会话列表，而它的卡片已经写好了**：`Shared/SessionCard.swift`（视图模型）
  + `Shared/StatusPalette.swift`（颜色，逐值对着 `lib/session-status.ts` 和
  `ctx-bar.tsx` 抄的）+ `LiveActivity/SessionCardViews.swift`（364 行 SwiftUI，
  只 import SwiftUI）。用 `UIHostingConfiguration` 把这些 SwiftUI 卡片放进
  `UICollectionView` 的 cell，**行渲染这部分不需要新写**，而且
  `tools/render-cards.sh` 那条「不用装机就能看见排版」的路子继续有效。
- **网页那边同时在后台预热**。今天冷启动是白屏等 Next 起来；改成原生列表先画本地
  快照（App Group 里上一次 `chat.listSessions` 的结果），同时让 WebView 在后台
  开始加载。等你点进某个会话时，网页通常已经起好了。
- **其余 31 个页面全部原样是网页**，从列表右上角一个按钮进去，落在
  `/usage`（现在的设置入口）。一个页面都不移植。
- **origin 从编译期常量改成可改的设置项**。今天 `AppConfig.origin` 是 `static let`
  硬编码 `https://dash.swaylab.ai`（`AppConfig.swift:8,16-22`），只有 `smoke.sh` 用启动
  参数覆盖过。sway 已定 `dash.swaylab.ai` 后续并入 `hermit`，所以这一条从「支持多部署」
  变成了「迁移那天不至于要卡着一次装机」。做法：值存 UserDefaults，默认值仍是编译期常量，
  校验照抄 `api-base.ts:28-44` 的 `normalizeBase()`（必须是裸 origin、非 localhost
  必须 https）。改完要按 `docs/multi-deployment-design.md:42-51` 的前提整个重来 ——
  tRPC、SSE、WS 三条连接全部拆掉重建，等同一次冷启动。

**要新写的那层网络。** 今天原生侧零 `URLSession`。好消息是不用啃 tRPC：仓库里已经有
两份手写的 tRPC-over-HTTP 调用可以照抄（`keyring.ts:140-176` 和
`apps/gateway/src/api.ts:150-214`），格式很短：

```
查询   GET  /api/trpc/<proc>?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%7D%7D
变更   POST /api/trpc/<proc>?batch=1   body: {"0":{"json":{…}}}
两者   header: x-asst-key: <key>
读取   j[0].result.data.json
```

**superjson 不用实现。** 我在 06:10 写过「返回 `Date` 的接口必须实现 meta 反序列化」，
**那句是错的**：superjson 把 `Date` 就写成 ISO 字符串放在 `json` 里，`meta` 只是给
JS 端还原类型用的。Swift 是静态类型，把字段声明成 `Date` 配 ISO8601 解码策略就行，
`meta` 整块忽略 —— 仓库里现有的两个手写调用方就是这么干的。全仓返回值里
**没有 `Map` / `Set` / `BigInt`**，只有 `Date`，所以这条捷径是安全的。

第二段只需要 4 个接口：`machines.me`、`chat.listSessions`、`chat.markRead`、
`push.register`（最后一个今天由网页发，搬过来才能在网页起来之前注册）。

**这一段的退出条件**：飞行模式下冷启动 1 秒内能看到上次的会话列表；
两个部署都能连；点进会话之后的一切和今天完全一样。

---

### 第三段：时间线（贵，且有闸门）

把 chat 那一屏做成原生，是本文里唯一一件真正昂贵的事。先把账摊开。

`app/chat` + `components/chat` + `lib/chat-cache` 一共 **20,230 行**（其中 2,648 行是
`node:test` 单测）。逐块判命运：

| 这一块 | 行数 | 到了原生会怎样 |
|---|---|---|
| 滚动稳定控制器 + 窗口化 + 高度预测 | ~3,100（另 1,500 测试） | **整块删掉。** `UICollectionView` 的 cell 复用替掉窗口化；`scrollView.isDragging` / `.isDecelerating` 替掉靠事件静默 180ms 猜「惯性停了」；TextKit 的 `boundingRect` 替掉用 `@chenglou/pretext` 预测折行高度 |
| 往前插入历史时的锚定 | ~890（另 670 测试） | **缩到约 200 行。** 这是个真问题，原生也不白送；但把 collection view 上下翻转（每个 cell 也翻转）之后，「在读者上方插入历史」变成「在下方追加」，`UICollectionView` 本来就保持偏移，尾部吸底也退化成 `contentOffset == .zero`。核心里约 200 行的 tail 分支直接消失 |
| 视口 / 安全区 / 键盘那套（`providers.tsx:100-145` + `globals.css:246-350`） | ~150 | **删掉。** 那 45 行 `visualViewport` 循环全是在补 iOS PWA 的 `innerHeight` 会短 62px 还来回跳；Auto Layout 和 safe area layout guide 没有这个问题 |
| markdown 渲染 | 456 行 + 依赖 | **必须换一份等价的。** 要 GFM 表格、围栏代码、14 种语言高亮；好消息是**没有数学公式、没有 mermaid**，这是实打实省下的范围。手机上还顺带甩掉 370KB —— 全 App 最大的那个 JS 块 |
| IndexedDB + 内存里的子串搜索 | ~965 | **换成 SQLite + FTS5**，对中文语料严格更好（现在是线性 `indexOf` 扫 11MB，因为所有 JS 全文检索库都按空格分词，一句中文会变成一个词） |
| `planSync` 同步计划器 + 它的线上协议 | 55 | **原样照抄。** 纯函数、自带测试，而且 `sync.ts` 本来就是手写 `fetch` 不走 tRPC 客户端 |
| 折叠规则、沉底规则、翻页的空洞证明、两级保真、块类型分发、交互卡片、队列语义、输入框手势、草稿、听写 | ~4,500 | **重写，然后永远跟着改。这才是真正的成本。** |

**必须先有、而且现在就该做的一件事：一份真正的消息块类型定义。**
今天没有：服务端 zod 是个带 `.passthrough()` 的宽松联合（`chat.ts:41-57`），
**`image` / `file` / `interaction` 三种最复杂的块根本不在 schema 里**，直接放行；
客户端的 `Block`（`components/chat/lib.ts:28`）是一个全可选字段的袋子，
`input` 和 `content` 是 `any`，`interaction` 连袋子里都没有，
`interaction-card.tsx:21` 收的是 `block: any`。

没有这份定义，原生端只能靠读四处代码去猜块长什么样。有了它，网页端也能把 `any` 去掉。
**它值得单独做，跟做不做原生无关。**

**折叠逻辑只能重写一遍，但可以让它不漂。** `fold-runs.ts` 是 323 行纯函数
（只 import `./lib` 和 `./sink-deliverables`，不碰 React），有 398 行测试。
Swift 要重写一份，约 250 行。防漂的办法是把 TS 那套测试的输入输出导成一份 JSON 夹具，
Swift 那份必须跑通同一份夹具 —— 一个实现两处，但有一处判据。

**第三段会终结「零第三方依赖」这条性质。** 原生 markdown 要么引 swift-markdown
（Apple 的，但仍是 SwiftPM 依赖），要么自己写一个 GFM 解析器。
`NSAttributedString(markdown:)` 是 Foundation 自带的，但它不支持表格和围栏代码块，
达不到现在的水平。这是个要认的代价，不是可以绕的。

**闸门 —— 三条全满足才开工，缺一条就不做：**

1. chat 那条路径的提交速度连续两个季度低于 40 个/90 天（现在是 264）。
   在它还在每 90 天净增 14,542 行的时候搬，等于追一辆正在加速的车。
2. 上面那份消息块类型定义已经落地，网页端已经在用它（不是「为了 iOS 才写的」）。
3. sway 明确把 iOS 当一等产品：有人每周出包、有人每周验，而不是「想起来才动一次」。

不满足就维持现状 —— 继续付那 3,353 行滚动基建的账。要说清楚这笔账不便宜：
它每 30 天还在改 23 次。但它至少是**一个**实现，不是两个。

---

## 五、三个前置决定（sway 2026-09-04 已答复）

### 决定一：壳可以持有机器密钥 —— **可以**

红线解除。原来写在 6 处（`apps/ios/README.md:109`、`NativeBridge.swift:6`、
`LiveActivityManager.swift:19`、`HermitLiveActivityBundle.swift:6`、`AppConfig.swift:26`、
`native-bridge.ts:5`），这 6 处文字要一起改掉，`PrivacyInfo.xcprivacy` 复核一遍。

改这条的理由不是「原生需要」，是**现状更差**：密钥今天已经在这台手机上，存在 WebView 的
localStorage 里（`keyring.ts:22`），没有加密、没有过期、清一次网站数据就全没。
搬进 Keychain 是提高安全性。红线是在壳只有 350 行、除了加载一个 URL 什么都不做的时候
写的，那时候「不要建一个凭据存储」是对的；今天的备选项不是「没有存储」，是「localStorage」。

落地时的三条硬要求：`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`（不同步 iCloud、
不进备份）；放 App Group 容器，通知扩展和原生列表共用一份；**退出登录必须连带清 Keychain**，
否则「清掉网站数据」不再等于登出。

顺带一件跟 iOS 无关但同样该做的：机器密钥今天**没有过期也没有轮换接口**
（`schema.prisma:17-25` 没有 `expiresAt`，轮换只能重跑 `seed-machine.ts`）。
以后想让手机拿的是可吊销的设备令牌而不是机器主密钥，那是服务端的活，对网页端同样有价值 ——
但**不要把它变成第一段的前置条件**，否则第一段永远开不了工。

### 决定二：分发只走 TestFlight —— **不上 App Store**

于是 `apps/ios/README.md:68` 和 `:256-263` 的说法照旧成立，不用改。

两个后果，一好一坏：

- **好的**：内部测试不过审，出一个包到能装上手机是分钟级。这让第一段和第二段更划算 ——
  原生和网页之间的版本差可以随时补，不用攒着等一次审核。也意味着第五节决定三那个迁移，
  「当天出一个新包」是可行的补救手段，只是不该是唯一的。
- **坏的**：我在上一版里把「4.2 审核压力」列成了支持做原生的理由之一。**那条不成立了，
  删掉。** 做原生的理由只剩第三节那四条实打实的能力，没有合规这一条。

也要跟着改的：内部测试上限 100 人，`release.sh` 那条手工签名的路（distribution 证书 +
app 与 `.LiveActivity` **两个** `IOS_APP_STORE` 描述文件）仍然是唯一出包方式，
`README:193-246` 那段照旧有效。

### 决定三：`dash.swaylab.ai` 后续并入 `hermit` —— 所以不做部署选择器，但 origin 必须能改

不做多部署切换 UI（少一处状态）。但**迁移这件事本身对 App 是有杀伤力的，而且是静默的**：

`AppConfig.origin` 是编译期常量（`AppConfig.swift:8,16-22`），`AppConfig.host` 由它派生
（`:24`）。而麦克风授权那一句是**精确比对**，不是 `isInternal`：

```swift
guard origin.host == AppConfig.host, type == .microphone else { ... .deny }
// WebViewController.swift:252
```

也就是说，迁移之后只要 App 装的还是旧包，麦克风就是拒绝 —— 而网页那侧的
`canOpenMicSilently()` 在壳里直接返回 true（`docs/ios-shell-design.md` 第四节），
**它不会退回到弹框，只会拿到一个 deny**。麦克风是这个 App 最初也是唯一的存在理由
（`apps/ios/README.md:15-19` 自己写的），迁移当天把它弄没了，不会有任何报错。

所以三件事，按顺序：

1. **先**把 origin 做成 UserDefaults 里的值（默认仍是编译期常量），在迁移之前发一个包。
   这一步做完，迁移当天就只是改一个设置，不是一场装机竞赛。
2. 迁移当天把默认值改成 hermit，出一个 TestFlight 包 —— 有第 1 步兜底，谁没更新也不至于砖。
3. 顺手复核麦克风那条判定要不要放宽到 `isInternal`。**不要顺手就放宽** ——
   `knownHosts` 是网页层报上来的，放宽等于把麦克风的授权范围交给页面决定。
   要改的话，判据应该是「用户自己配过的那个 origin」，不是「页面说它认识的那些」。

推送这边不用担心：`hermit.zhinan.tech` 的 APNs 凭据 2026-09-04 03:18 已经补齐，
`push.status` 从 `configured:["bark"]` 变成 `["ios","bark"]`，`push.test` 通了。

## 六、防漂移：把「静默坏一个月」变成一次响亮的失败

前面那次 5 周的静默失效不是谁疏忽，是**没有任何一处会因此报错**。原生化只会放大这件事：
今天壳里已经有一处漂了 —— `LiveActivityManager.swift:36` 的 `workingStaleAfter` 是
10 分钟，服务端 `live-activity.ts:61` 的 `WORKING_STALE_MS` 是 15 分钟，
设计文档写的也是 15。没人发现，因为服务端每次更新都带权威的 `staleDate`，
只有 App 自己起的第一帧会用到那个错值。

三条，从便宜到贵：

**① 抄过去的常量改成生成的。** `Shared/StatusPalette.swift` 是照着
`lib/session-status.ts` 和 `ctx-bar.tsx` 逐值手抄的，`workingStaleAfter` 这类超时同理。
把它们集中到一个 TS 模块，写个脚本生成对应的 Swift 文件，再加一个测试断言
「生成的内容和仓库里那份一致」。

仓库**没有 CI、没有 git hook**，但有一个现成的入口：`apps/dashboard/package.json` 的
`test` 脚本已经在跑 `tsx --test src/lib/*.test.ts`。把这个断言写成
`src/lib/ios-contract.test.ts` 就够了 —— 不新增任何基础设施，谁跑 `pnpm test` 谁就撞到。

**② 桥要协商版本。** `ready` 的时候壳报一份自己支持的能力清单，网页端用某个能力之前
先查；壳太旧就降级并提示更新，而不是调一个不存在的方法然后静默什么都不发生。

**③ 不认识的东西要画出来，不能画成空白。** 这条本来就是这个仓库的既有纪律：
`SessionActivityAttributes.swift:26-31` 的 `phase` 故意用 `String` 不用 enum，
`SessionCard.swift:33-45` 的 `init(_ raw:)` 认不出来就回落 `.working`。
原生渲染时间线时照办：不认识的块类型画成一张写着类型名的灰卡片，
这样网页端加一种新卡片时，旧版本 App 上是「有个东西但还没适配」，不是消息凭空少一条。

---

## 七、验证计划

| 段 | 怎么验 | 谁 |
|---|---|---|
| A0 桥的问答通道 | 网页端发 100 条并发请求，全部拿到配对的回答；超时那条走超时分支 | 模拟器 |
| A1 Keychain | 系统设置里清掉 App 的网站数据 → 重开仍是登录态；卸载重装 → 需要重新输密钥 | **真机** |
| A2 出站队列 | 飞行模式发 3 条 → 关掉 App → 开飞行模式关掉 → 重开 App，三条自己发出去且**服务端只有 3 行** | **真机** |
| A2 幂等 | 同一个 `clientId` 连发两次，`ChatMessage` 只多一行 | `pnpm test` |
| B 前门 | 飞行模式冷启动 1 秒内看到上次的列表；两个部署都能连；点进会话和今天一样 | **真机** |
| B 卡片排版 | `tools/render-cards.sh` 出 PNG，装机之前先看一眼（这条路今天就通） | 本机 |
| origin 可改 | 把 origin 指到另一个部署 → 三条连接全部重建、麦克风仍然免弹框 | **真机** |
| 防漂移 | 故意改掉 `session-status.ts` 里一个颜色，`pnpm test` 必须红 | 本机 |

模拟器上验不了的：APNs、麦克风、真实的滚动手感。这三样任何时候都只能真机。
跑完模拟器记得 `xcrun simctl shutdown all` —— `apps/ios/smoke.sh` 的 `trap` 已经做了，
手工跑的别忘（`docs/ios-shell-design.md` 那段实测：一台空转的模拟器 285 个孤儿进程、
约 3.4G 内存压力）。

---

## 八、风险

1. **第一段做完，看起来什么都没变。** 三件事都是「坏的时候才看得出来」的能力。
   如果期待的是「打开 App 感觉不一样」，那要到第二段。这个预期要先对齐，
   否则第一段做完会像白做。
2. **前门原生之后，多了一个会说谎的地方。** 原生列表和网页列表是两份实现，
   已读状态、排序、未读数任何一处不一致，用户看到的就是「App 和网页对不上」。
   缓解办法是原生列表只做**一个** tRPC 查询（`chat.listSessions`），
   排序和分组规则不要在 Swift 里重新发明。
3. **第三段一旦开工就不能半途停。** 时间线做到一半、一部分原生一部分网页，
   是所有形态里最糟的：两套滚动、两套渲染、两套 bug。要么整屏，要么不动。
4. **出站队列会给服务端带来重复消息**，除非 `chat.send` 先加幂等键。
   这个顺序不能反 —— 先加键，再做队列。
5. **`dash.swaylab.ai` 并入 `hermit` 那天，麦克风会静默失效**，除非 origin 已经能改
   （决定三）。这是本文里唯一一条「不做原生也会发生」的风险，所以它的优先级在
   第一段之上。
6. **本机能力已经不是瓶颈了**（Xcode 26.6、iOS 26.5 SDK、xcodegen 2.46、
   系统盘余 355G），但真机验证仍然只能靠 sway 的设备和付费账号。
   代码侧最多只能保证「编译过、逻辑对」。
