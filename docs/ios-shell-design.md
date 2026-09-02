# Hermit iOS 套壳 App — 设计

**Goal:** 把 `dash.swaylab.ai` 装进一个原生 iOS 壳，解决两件 Web 在 iOS 上做不到的事：**① 麦克风一次授权、永不再弹**（现在每次 `getUserMedia` 都重新弹系统框，语音输入基本没法连续用）；**② 真正的推送**（锁屏可达、秒级、可靠）。

**Non-goals(v1):** 原生 UI（会话列表 / 聊天气泡都仍是网页）、离线阅读、Apple Watch、iPad 适配打磨、上架 App Store、Android。

---

## 为什么是原生壳而不是继续 PWA

网页侧目前已经很硬：`manifest.ts` + `sw.js`（cache-first 不可变资产）、`viewportFit: 'cover'` + safe-area、`interactiveWidget: 'resizes-content'`。PWA 能榨的基本榨完了。剩下两个天花板是 WebKit 的策略，不是代码问题：

| | iOS Safari / 主屏 PWA | WKWebView 壳 |
|---|---|---|
| `getUserMedia` 授权 | **每次调用重新弹框**，不持久化 | 壳里 `.grant`，网页永不见框 |
| Push API | 仅主屏 PWA（iOS 16.4+），以静默失效著称 | **完全不支持** → 必须走原生 APNs |

注意第二行：套壳会**丢掉** Web Push 这条路。所以「壳」和「推送」是绑定决策——要壳就必须自己接 APNs。这也是本方案需要付费 Apple Developer 账号的唯一原因（`aps-environment` entitlement 免费账号拿不到）。

> **后续（2026-08）：推送已经不再和这个壳绑定了。** `docs/no-app-push-design.md` 把最后一跳抽成 `push/transport.ts`，另外接了 Web Push（主屏 PWA）和 Bark 两条通道，两条都不需要付费开发者账号。本文其余部分照旧有效——**麦克风免弹框仍然只有原生壳能做到**，那才是这个壳现在的唯一理由。

`apps/dashboard/src/lib/voice-capture.ts:36-38` 的注释早就点名了这件事：warm-mic 只修首字截断，「NOT a workaround for iOS's per-getUserMedia permission re-prompt (that's left to a future native app)」。本文就是那个 future native app。

## 选型：纯 Swift + WKWebView

Capacitor / React Native 底下也是 WKWebView，麦克风那个 delegate 照样得自己写；换来的是一整条 npm 构建链和会腐烂的插件依赖。这个 App 一共三件事：授权麦克风、注册 APNs、加载一个 URL。**~350 行 Swift，零第三方依赖**，`xcodegen` 从 `project.yml` 生成工程。

---

## 架构总览

```
iOS App  apps/ios/                        dash.swaylab.ai (VPS:4101, 单实例 tsx server.ts)
┌────────────────────────────┐            ┌──────────────────────────────────────┐
│ WKWebView(全屏, 持久化 store)│──HTTPS──▶│ Next dashboard(现状, 网页零改动)      │
│                            │            │                                      │
│ WKUIDelegate               │            │ ┌── 新增 ─────────────────────────┐  │
│  requestMediaCapturePermission          │ │ prisma  PushDevice              │  │
│    → .grant   ← 麦克风核心  │            │ │ lib/push/apns.ts   ES256+http2  │  │
│                            │            │ │ lib/push/suppress.ts  纯函数     │  │
│ AVAudioSession .playAndRecord           │ │ lib/push/enqueue.ts  事件入口    │  │
│                            │            │ │ server/routers/push.ts          │  │
│ APNs 注册 → deviceToken     │            │ └─────────────────────────────────┘  │
│      │                     │            │        ▲ 四个已有写入点各挂一钩       │
│      ▼ WKScriptMessageHandler           │        │                             │
│ 网页 lib/native-bridge.ts   │───tRPC────▶│ push.registerDevice              │
└────────────┬───────────────┘            └────────────────┬─────────────────────┘
             │                                             │ APNs HTTP/2
             └◀────────────── 推送通知 ─────────────────────┘
```

**网页侧改动不大，但不是零**：`lib/native-bridge.ts` + 在 `Providers` 里挂一次，SSE、终端 WS、keyring 原样工作。
除此之外网页层必须**知道自己在壳里**——`isNativeShell()` 的调用点见下面「四、壳要表明身份」。
2026-08 之前这个函数定义了却一处没用，代价是网页端整套 iOS 适配在壳里全部失效。

---

## 一、麦克风（核心）

### 根因

iOS 的 `getUserMedia` 授权是**每次调用**由 WebKit 询问，且不跨调用持久化。网页侧无论怎么写都绕不开——warm-mic 复用同一个 `MediaStream` 只能在 20 秒热窗内躲过，超时就又弹。

### 解法

WKWebView 从 iOS 15 起把这个决定权交给宿主 App：

```swift
func webView(_ webView: WKWebView,
             requestMediaCapturePermissionFor origin: WKSecurityOrigin,
             initiatedByFrame frame: WKFrameInfo,
             type: WKMediaCaptureType,
             decisionHandler: @escaping (WKPermissionDecision) -> Void) {
    // 只对自家 origin 放行；其它一律 deny（壳里理论上不该出现别的 origin）
    guard origin.host == AppConfig.host, type == .microphone else {
        return decisionHandler(.deny)
    }
    decisionHandler(.grant)
}
```

**这一句就是整个方案的核心。** 系统层面的麦克风权限只在 App 首次录音时问一次（`NSMicrophoneUsageDescription`），之后网页侧再也见不到任何框。

### 三个必配项（漏一个就是坑）

1. **`Info.plist` 的 `NSMicrophoneUsageDescription`** — 不填，一碰麦克风直接 crash，不是报错。
2. **`AVAudioSession` 分类** — 默认 `.soloAmbient` 下录音**静默失败**（拿得到 stream，采到的全是静音）。首次录音前设 `.playAndRecord`（`.duckOthers` + `.defaultToSpeaker`），录完 `setActive(false, options: .notifyOthersOnDeactivation)` 把背景音乐还回去。壳无法感知网页何时开始录音，所以策略是：**在 `.grant` 的同时激活音频会话**，并在 App 进后台时释放。
3. **`WKWebViewConfiguration`** — `allowsInlineMediaPlayback = true`、`mediaTypesRequiringUserActionForPlayback = []`。

### Web 侧

不动。`voice-capture.ts` 的 warm-mic 保留（它修的是首字截断，与权限正交）。仅更新 `:36-38` 那条已经过时的注释。

---

## 二、推送

### 注册链路（native 不碰 machine key）

```
App 启动
  → UNUserNotificationCenter.requestAuthorization([.alert,.sound,.badge])
  → UIApplication.registerForRemoteNotifications()
  → didRegisterForRemoteNotificationsWithDeviceToken(hex)
  → webView.evaluateJavaScript("window.__hermitNative.onPushToken('<hex>')")
  → 网页遍历 keyring 的每个 entry，各调一次 push.registerDevice({ token })
  → 一台设备订阅你所有机器
```

关键设计：**原生代码完全不接触 machine key**。token 交给网页，网页用它已有的、已鉴权的 tRPC 客户端去登记。好处是鉴权零新逻辑、多机器天然支持（keyring 有几台就登记几条）、scoped 分享 key 也能用（`push.registerDevice` 用 `machineProcedure`，scoped key 自动 403，符合现有边界）。

### 触发：事件驱动，不轮询

**不新增任何周期扫描**（见 auto-memory `feedback_no_per_tick_scans`）。四个已有写入点各挂一个 `enqueuePush()`：

| 事件 | 挂载点 | 载荷 |
|---|---|---|
| `blocked` agent 卡住等你 | `/api/sync/interaction` 创建 Interaction 时 | agent 名 + 问题摘要 |
| `chat` agent 回复了 | `/api/sync` 写入 assistant ChatMessage 时 | agent 名 + 首段文本 140 字 |
| `cron` 定时任务挂了 | CronRun 落 status 时，**仅** `timeout`/`error`/`no_output` | cron 名 + status |
| `host` 机器红警 | sync 路由里 `redAlertAt` 跨红线时 | 机器名 + 剩余内存/负载 |

`enqueuePush()` 是 fire-and-forget（`void enqueue(...).catch(log)`），**绝不 await**——推送失败不能拖慢或失败 sync 写入。

### 抑制规则

**① 合并** — 每条推送都带 `apns-collapse-id`（chat/blocked 用 `sessionId`，cron 用 `cron-<id>`，host 用 `host-<machineId>`）。同一个会话/任务/机器在锁屏上永远只占一格，新的**替换**旧的。这不是「决策」，是每条推送的固有属性，所以不进 `shouldPush`。

blocked 和 chat 共用 sessionId 作为 key 是刻意的：「agent 卡住了」应该顶掉同一会话的「agent 回复了」，而不是并排堆着。

**② 去抖（只对 chat）** — 一次 agent 回合会写入十几条 ChatMessage（文本块、tool_use、tool_result、又一段文本），每条都推就是一次回复炸出十几条通知。所以 chat 事件按 session 做 **20 秒尾随去抖**：新消息重置计时器，静默 20 秒后才发，内容取**最后一条**文本——那通常也正是值得读的那段。另外三类是离散事件，立即发。

**③ 决策**（纯函数 `shouldPush`，好单测）
- **正在看的不推** — 该会话 `lastReadAt` 在 60 秒内 → 丢弃。
- ~~**静音时段**~~ — 曾经是 23:00–08:00 只放行 `blocked` / `host` / `stall`，**已移除**。服务端按时钟静默丢弃通知，意味着你凌晨一点真正需要的那条永远不会到、而且没有任何地方说得出原因。时段判断交给手机：iOS 专注模式能按人、按日程配，还对使用者可见。服务端只保留紧急度标记（`URGENT_KINDS`），让专注模式自己决定放不放行。

②③ 都在**投递时**求值而非入队时。对去抖中的 chat 事件这是个好性质：那 20 秒里你打开了会话，这条推送就自动取消了。

去抖计时器放**进程内 Map**：dashboard 是单实例 fork 模式（`ecosystem.config.cjs` 无 `instances`/`cluster`），不需要建表。进程重启最坏是丢一条待发通知。

### 发送：零新依赖

APNs 只需要一个 ES256 JWT + 一个 HTTP/2 POST，Node 内置模块全都有：

- **签名** — `node:crypto` 的 `crypto.createPrivateKey(p8)` + `sign('sha256', ..., { dsaEncoding: 'ieee-p1363' })`。JWT 缓存复用 50 分钟（APNs 要求 ≥20 分钟换一次、≤60 分钟必须换）。
- **传输** — `node:http2` 连 `api.push.apple.com:443`，session 复用（APNs 强烈建议长连接，不要每条一个连接）。
- **失败处理** — 410 `Unregistered` / 400 `BadDeviceToken` → 从 `PushDevice` 删掉该 token；其余记日志不重试（推送不是关键路径）。

### 凭据

APNs 的 `.p8` 私钥**绝不进 git**（仓库是公开的）。走 `secret` store：

```
APNS_KEY_P8      # .p8 文件全文（单行 .env 里的字面 \n 会被还原）
APNS_KEY_ID      # 10 位 Key ID
APNS_TEAM_ID     # 10 位 Team ID
APNS_BUNDLE_ID   # ai.swaylab.hermit
```

VPS 上 dashboard 由 pm2 起，从 `apps/dashboard/.env` 读（与既有的 `OPENROUTER_API_KEY` 同一个模式）。四个变量缺任何一个 → 推送模块自动 no-op 并在启动时 warn 一次，本地开发不受影响。

### 点击跳转

payload 附 `path`（如 `/chat?session=<id>`）。App 收到点击 → 若 webview 已加载则 `evaluateJavaScript` 调 bridge 的 `onDeepLink(path)` 走前端路由；未加载则作为初始 URL。

> **注意** 前端路由这里要用 `window.location.href` 硬导航，不能用 `router.push` —— Next16 + custom server 下程序化导航到同路由 query 变更不跳（见 auto-memory `hermit-ui-router-nav-callback`）。

---

## 三、壳的其余部分

一次性把 PWA 的老坑抹平：

| 关注点 | 做法 |
|---|---|
| **数据持久化** | `WKWebsiteDataStore.default()` — localStorage 的 keyring 跨启动保留，key 只输一次 |
| **安全区** | webview 铺满 window，`scrollView.contentInsetAdjustmentBehavior = .never`；网页负责插内边距，壳不要重复插——但网页那套是 `@media (display-mode: standalone)` 写的，WKWebView 报 `browser`，所以壳必须先给 `<html>` 打上 `native-shell` 标记，见「四」 |
| **离线** | `didFailProvisionalNavigation` → 原生重试视图（**不能**指望 `offline.html`：SW 在 WKWebView 里对首次导航无能为力） |
| **多部署** | 一个 App 可以驱动多个 dashboard 部署，而壳没有钥匙串（它故意不持有任何凭据），所以网页层在 `ready` 之后补发 `{type:'origins', origins:[...]}`，壳存进 `AppConfig.knownHosts`。少了这一步，第二个部署的图片和链接会被判成站外扔给 Safari —— 另一个存储仓，等于走出了 App。判定是带点的后缀匹配（`evilexample.com` 不算 `example.com` 的子域），单测在 `apps/ios/HermitTests/AppConfigTests.swift` |
| **外链** | `decidePolicyFor navigationAction`，**只管主框架**：子框架是页面自己的事（预览面板 iframe 指向 `preview.swaylab.ai`，故意的另一个源），拦下来会让面板永远空白还弹出 Safari 浮层。非本站 http(s) → `SFSafariViewController`；`tel:`/`mailto:` → `UIApplication.open`；其余 deny |
| **新窗口** | `target="_blank"` 走 `PopupWebViewController`：`createWebViewWith` 返回 nil，另建一个 webview（自己的 configuration，显式 `WKWebsiteDataStore.default()`，和主 webview 同一个仓）盖在上面。**不**用 WebKit 递过来的 configuration —— 那个对象是 WebKit 的，改它的 `userContentController` 是在动别人的东西；这里也不需要 opener 关系。塞回主 webview 会丢掉当前会话和没发出去的草稿；丢给 Safari 则是另一个 cookie 罐，登录态没了 |
| **附件下载** | `navigationAction.shouldPerformDownload` → `.download`（`<a download>` 的那一半，少了它整个 dashboard 会被一张原图顶替），加 `WKDownloadDelegate` → 存 tmp → `UIActivityViewController`。桌面端那个 `canShare` 坑（auto-memory `hermit-ui-desktop-download-share-gate`）在原生侧不存在 |
| **音频会话** | 网页层每次开/关麦克风流都发 `{type:'mic', active}`，壳据此 `setActive`。不能只靠权限回调（WebKit 手上还有授权时根本不回调，于是「录音 → 回桌面 → 回来再录」录到纯静音），也不能改成回前台就激活（那样一次语音之后，整个启动周期里每次回到前台都会压低别的 App 的声音，AirPods 还会从立体声掉到单声道） |
| **回前台** | `willEnterForeground` → 下一个 runloop 再 `evaluateJavaScript` 触发一次 `visibilitychange`，**且只在 `document.hidden` 为 false 时发**——聊天页的处理函数在 hidden 为 true 时是断开而不是重连，而这一刻 WebKit 有没有翻回 false 取决于观察者注册顺序 |
| **缩放** | `scrollView.pinchGestureRecognizer?.isEnabled = false` — 比网页那套 `gesturestart preventDefault` 干净 |
| **终端页** | `/chat/terminal` 的 WS + subprotocol 在 WKWebView 原生支持，无需特殊处理 |
| **下拉刷新** | v1 不做。webview 内多处自有滚动容器，`UIRefreshControl` 会打架；SSE 断线自愈已覆盖 |

---

## 四、壳要表明身份（2026-09 补）

网页端所有 iOS 适配都写在 `@media (display-mode: standalone)` 或 `isStandalone()` 里。
**WKWebView 报的是 `display-mode: browser`，`navigator.standalone` 是 undefined** —— 于是这些
适配在它们本来要服务的这个 App 里整套静默失效：顶栏钻到刘海底下、键盘盖住输入框、
lightbox 关闭按钮落在状态栏里被系统吃掉点击、`/push` 页叫一个已经在 App 里的人去
「点 Safari 分享按钮添加到主屏幕」。

做法：`WebViewController.shellMarkerScript` 在 documentStart 给 `<html>` 加 `native-shell` 类
（必须是首帧之前，否则第一帧就是错的；`layout.tsx` 的 `<html suppressHydrationWarning>` 保证
React 不会跟它抢这个属性）。CSS 侧 `globals.css` 把安全区和 `--app-h` 改成变量驱动，
standalone 和 `html.native-shell` 喂同一组变量；JS 侧用 `isNativeShell()`。

现在的调用点：

| 位置 | 在壳里做什么 |
|---|---|
| `globals.css` | 安全区内边距 + `--app-h` 生效（否则完全不生效） |
| `keyboard-shortcuts.tsx` | ⌘K / ⌘1-6 / `?` 生效（iPad 接键盘时看得见） |
| `voice-capture.ts` `canOpenMicSilently()` | 直接返回 true —— 壳替网页应答授权，根本没有弹框要躲 |
| `web-push-client.ts` `pushSupport()` | 返回 `native-shell`，不再谎报 `needs-install` |
| `app/push/page.tsx` | 换成原生 APNs 状态卡片 |
| `install-prompt.tsx` | 不显示「添加到主屏幕」横幅 |

## 五、通知授权的时机（2026-09 改）

原来在 `didFinishLaunchingWithOptions` 里就 `requestAuthorization`。那是冷启动的第一秒，
用户还没输机器密钥 —— 网页层拿到令牌也没有机器可注册（`installNativeBridge` 是按 keyring
逐台注册的，空钥匙串等于什么都不做），而 iOS 的通知授权**一辈子只问一次**，点了「不允许」
就只能去系统设置里改。等于在最坏的时机问，答案还被扔掉。

现在：App 启动只做「上次已经授权过 → 静默重新注册拿新令牌」；真正的询问由网页层在
`installNativeBridge()` 里发起，条件是钥匙串里至少有一台非 scoped 的机器。
`/push` 页还有一个显式按钮，供 `notDetermined` 状态下手动触发。

协议（`NativeBridge`）：

```
web → native   { type: 'requestPush' }   问一次（已问过则只回报现状）
web → native   { type: 'pushStatus'  }   只读，永不弹框
native → web   window.__hermitNative.onPushStatus(status, registered)
                 status: notDetermined | denied | authorized | provisional | ephemeral | unknown
                 registered: 系统是否真的给了 APNs 令牌（模拟器上恒为 false）
```


---

## 数据模型

```prisma
model PushDevice {
  id         String   @id @default(cuid())
  token      String                        // APNs device token (hex)
  machineId  String
  machine    Machine  @relation(fields: [machineId], references: [id], onDelete: Cascade)
  platform   String   @default("ios")
  apnsEnv    String   @default("sandbox")  // sandbox | production —— 见下
  createdAt  DateTime @default(now())
  lastSeenAt DateTime @updatedAt

  @@unique([token, machineId])             // 同设备同机器只一条；注册是 upsert
  @@index([machineId])
}
```

只此一张表。去抖状态在内存，不落库。

**`apnsEnv` 为什么必须存**：Xcode 直装的 build 拿到的 token 只有 **sandbox** 主机认，TestFlight 的只有 **production** 认，发错主机返回 `BadDeviceToken`。两种 token 长得一模一样，服务端**猜不出来**。所以由 App 在注册时上报——而且不能用 `#if DEBUG` 判断（Release 配置从 Xcode 装上去，带的仍是 development 描述文件），必须读 `embedded.mobileprovision` 里的 `aps-environment`。见 `apps/ios/Hermit/ProvisioningProfile.swift`。

---

## 分发

- Bundle ID `ai.swaylab.hermit`，Team 用 sway 的付费账号
- **自用**：Xcode 直接装到设备，profile 一年有效
- **给别人**：TestFlight 内部测试（100 人，无需审核）
- **不上 App Store**：纯 webview 壳撞 App Review 4.2 minimum functionality，收益为零

---

## 验证计划

| 层 | 手段 | 结果 |
|---|---|---|
| 抑制规则 | `npm test` 纯函数单测（已读窗口 / 静音时段跨午夜 / 时区） | ✅ 10 例通过 |
| APNs 签名 | 用临时 P-256 密钥签 + 验，确认是 raw r‖s 64 字节而非 DER | ✅ 8 例通过 |
| dashboard | `tsc --noEmit` + `eslint` + `next build` | ✅ 全绿，lint 无新增问题 |
| iOS 源码 | `swiftc -typecheck` 对 iPhoneOS26.5 SDK | ✅ 零错误零警告 |
| iOS 工程产物 | `xcodebuild` | ⚠️ 本机 iOS platform 组件未安装（Xcode 26 按需下载）+ CoreSimulator 版本不一致，**未产出 .app** |
| **麦克风** | **真机**：长按录音 → 转写 → 落字，连续 5 次，确认零权限框 | ⬜ 待 sway |
| **推送** | **真机**：`push.test` + 四类事件各一次，确认锁屏可达 + 点击跳对会话 | ⬜ 待 sway |

最后三行的缺口是真实的，不要当成「已验证」：

- **`xcodebuild` 没跑成**。Swift 编译层面是干净的（`swiftc -typecheck` 全过），但链接、资源打包、签名、Info.plist 合并这些只有真正 build 才会暴露的问题没被覆盖。第一次在 Xcode 里打开可能还要收拾一两处。补齐方式：`xcodebuild -downloadPlatform iOS`（几个 GB），CoreSimulator 的版本不一致一般重启解决。
- **麦克风与推送必须真机**。模拟器没有 APNs 注册，麦克风行为也与真机不同。这两条正是本项目存在的理由，在 sway 拿设备验之前，整套东西只能算「设计正确、编译通过」。

> ⚠️ **第一次连真机会在系统盘上创建几个 G，而且和上面那套模拟器的收尾毫无关系。**
>
> `~/Library/Developer/Xcode/iOS DeviceSupport/<版本>` —— 每个 iOS 版本一份符号文件，
> **单份几个 G**，连一次新版本就多一份，不会自己清。`~/Library/Developer/Xcode/Archives`
> 每归档一次多一份。这两个目录在只跑模拟器的机器上**根本不存在**（2026-09-02 实测本机没有），
> 所以照着上面模拟器那节做收尾的人，不会知道自己漏了什么。
>
> 这正是同一个盲区高一层的样子：模拟器那节教你清 DerivedData、结果包、设备容器，
> 而这一条是**换一条路径之后全新的一组东西**。真机验证之前先看一眼这台机器还剩多少
> （`df -h /System/Volumes/Data`，注意不是 `df -h /`）；验完不再用的旧 iOS 版本符号
> 直接删 `iOS DeviceSupport` 下对应目录，下次连设备会重新生成。

> ⚠️ **在 mac-local 上跑完模拟器，必须显式 `xcrun simctl shutdown all`。**
>
> `xcodebuild test` 退出**不会**带走模拟器。运行时进程（`SimRenderServer`、`SimMetalHost`、
> `SimAudioProcessorService`、`launchd_sim`…）会变成 `ppid=1` 的孤儿继续空转（实测 285 个）。
> 关掉 Simulator.app 的窗口**不够**，那些进程还在。
>
> **别用 `ps` 的 RSS 相加来估它占多少内存**——模拟器进程之间大量共享页，把 285 个 RSS 加
> 起来会重复计数，2026-09-02 那晚两个 agent 分别加出 2.2G 和 4.8G，都不对。看**变化量**：
> 关掉后空闲内存 +1176M、compressor -2237M、交换区 -3072M，**约 3.4G 的真实内存压力缓解**。
>
> 这在这台机器上不是小事：16G 内存长期被 Figma 和十几个 claude 会话吃满，再多 4.8G 就会
> 触发内存压力，macOS 开始往**系统盘**写 1G 一个的交换文件。2026-09-02 凌晨实测：一个空转
> 十分钟的模拟器 → 285 个孤儿进程、空闲内存 249M、内存压力等级 2、交换区 10 个文件；
> `simctl shutdown all` 之后 → 0 个进程、空闲 1425M、压力回到 1、macOS 自己删掉 3 个交换
> 文件、**系统盘凭空回来 3.1G**（盘上一个文件都没删）。
>
> 当晚系统盘只剩 12.89G，而同一台机器在 2026-09-01 05:57 就因为系统盘撞零死过一次：pm2
> 和它下面 18 个 app 全灭，网关黑了 3 小时 57 分，本机所有 dashboard 会话和所有 cron 一起停。
> 跑一次 iOS 测试通过「内存不够 → 写交换文件」间接吃掉几个 G 系统盘——这条链没人会预料到，
> 所以写在这里。
>
> **收尾写进脚本，不要只写进文档**——`apps/ios/smoke.sh` 已经这么做了（`trap cleanup EXIT`），
> 那才是以后真正的入口。而且只关**自己启动的那台**：先探一次 Booted 状态，别人已经开着的
> 不动它。`xcrun simctl shutdown all` 会误伤同机其它会话正在用的模拟器——2026-09-02 那晚
> 就发生过一次反向的：排查磁盘的人看到一个 booted 设备、`pgrep` 正好撞在测试循环的间隙查不到
> `xcodebuild`，判成孤儿关掉，打断了一个正在跑的验收，对方还以为是自己脚本坏了。
>
> 同一个 trap 里顺便清两样，都默认落在系统盘：DerivedData（`$TMPDIR/hermit-ios-dd`，要迭代
> 用 `HERMIT_KEEP_DERIVED=1` 保留），以及 `.xcresult` 结果包——**后者记着 test runner 的
> 环境变量，机器密钥会躺在里面**，那不只是占空间。
>
> ⚠️ **`$TMPDIR` 和 `/tmp` 都不是「盘外」。** macOS 上 `$TMPDIR` 解析到
> `/private/var/folders/…`、`/tmp` 是 `/private/tmp`，两个都在系统盘（`/System/Volumes/Data`）
> 上。把 `HERMIT_DERIVED_DATA` 指到它们等于原地打转。真要搬走只能指到外接卷；在那之前，
> **删干净才有用，改路径没用**。
>
> ⚠️ **构建产物不是唯一在涨的东西，设备本身才是大头。** 2026-09-02 实测：一小时四轮冒烟
> 测试之后，`~/Library/Developer/CoreSimulator` 从约 192M 涨到 **2.1G**，而同一时刻
> `$TMPDIR/hermit-ios-dd` 只有 100M、`~/Library/Developer/Xcode` 只有 18M。涨的是模拟器
> **设备的数据**（装进去的 App、容器、快照），trap 里删 DerivedData 和 `.xcresult` 一个字节
> 都碰不到它。冒烟测试本来就该从干净设备开始，所以构建之间顺手：
>
> ```
> xcrun simctl erase <device>          # 擦掉这台设备的数据
> xcrun simctl delete unavailable      # 清掉运行时已卸载后残留的设备
> ```
>
> 验证：`xcrun simctl list devices booted` 应为空。
>
> 另：看这台机器的余量要用 `df -h /System/Volumes/Data`。`df -h /` 看的是只读系统卷，会
> 显示 45–58% 这种健康数字，而同一时刻 Data 卷是 94%——两个卷共享容器可用空间，可用 GB
> 一致而百分比差 36 个点。只看可用 GB 最不容易错。

---

## 风险

1. **真机验证缺口** — 麦克风与推送两条主线的最终确认都依赖 sway 的设备与开发者账号，代码侧只能保证编译通过与逻辑正确。见验证计划表末三行。
2. **APNs 凭据未就位前推送整条链路是 no-op** — 设计上是刻意的（缺 env 不炸，只在启动时 warn 一行），但也意味着「部署完没报错」不等于真能推。判断标准只有一个：真机收到通知。
3. **系统麦克风权限被拒之后**壳里的 `.grant` 也救不了——`WKUIDelegate` 只能代答网页层那次询问，系统层的开关在 iOS 设置里。首次启动被误拒的话要去「设置 → Hermit → 麦克风」手动打开。
