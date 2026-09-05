# iOS 原生化 — 进展

**这个文件是每轮之间唯一的记忆。** 每小时一轮的 cron 先读它，再接着做，收尾时写回来。
方案在 `docs/ios-native-design.md`。

## 目标（sway 2026-09-04；交互那条 2026-09-05 15:05 被推翻）

**全部原生。** 这明确覆盖了设计文档里「不要全原生、第三段设闸门」那条建议 ——
文档保留原样不改，因为它记录的成本估算仍然成立，只是决定不同了。

- **静态呈现要和网页一致**：布局、间距、字号、颜色、状态色、空态文案，逐屏截图比对。
- **交互也要和网页完全一致。** sway 09-05 15:05 原话：「要和网页交互和 ui 保持完全一致」。
  这一条**推翻**了原来那句「交互按 iOS 平台惯例，照抄网页的物理反而会把做原生的理由抵消掉」
  —— 原话留在这里，因为它解释了第 11–15 轮为什么长成现在这样，但**不再是准绳**。
  从这一轮起：凡是原生控件的默认行为和网页不同，**以网页为准** —— 导航的形状、
  哪个手势归谁、动画时长和曲线、长按菜单、键盘避让，都照 dashboard 的实现移，
  别用系统默认，也别拿「iOS 上就该这样」当理由。

### 这条一改，已经落地的四件要跟着回退或改形

1. ~~**前门必须退回网页的形状。**~~ **第 4 轮 perfect-goal 做掉了。** 网页 `/` → `/chat`
   会恢复 `lastSessionId()` —— **打开就在上次那个会话里**，会话列表是盖在它上面的左抽屉
   （`app-sidebar.tsx:181`：`w-[280px]`、`transition-transform duration-200 ease-out`，
   遮罩 `bg-foreground/20` `duration-150`）。第 15 轮把全屏原生列表当成根，那是**网页上
   根本不存在的一页**；sway 装上 build 7 第一次看见就提了。
   现在网页又是栈底，列表退回 `hermit://sessions` 后面，一行都没删 —— 它就是原生抽屉的内容。
2. ~~**左边缘归抽屉，不归返回手势**~~ **第 4 轮一起做掉了，而且不需要改任何一行网页代码。**
   偷走左边缘的从来不是 `setNativeEdgeSwipe`（那管的是 WKWebView 自己的前进/后退手势，
   默认就是关的、由页面按需打开），是 `UINavigationController` 的 `interactivePopGestureRecognizer`
   —— 网页回到栈底之后它在那一屏栈深为 1，UIKit 自己就不放行了。
   `gestureRecognizerShouldBegin` 里那条「当前这屏是网页就不放行」是第二道锁，
   不是修法本身。手势的数在 `components/sidebar/use-drawer-swipe.ts`：`W=280`、`EDGE=28`、
   `SLOP=10`、`EDGE_SLOP=5`、`FLICK=0.3 px/ms`、`STALE_MS=80`。将来原生那份要吃同一组数
   （照 status / blocks / fold 那个共享夹具的老套路导出来）。
3. **等宽字体塞进包里** —— 第二条待拍板定案。网页用的是 **Geist Mono**
   （`globals.css:11` `--font-mono: var(--font-geist-mono)`），不是系统等宽；
   第 17 轮量出来的 3% 宽度差在「完全一致」之下就是必须消掉的，办法是把字体文件放进 target。
4. **`/chat/terminal` 保持网页** —— M6 最后一条按新目标解释就是这个答案：xterm.js 的行为
   要「完全一致」，只能是它自己。仍标着「可被 sway 推翻」。

**顺带一个成本要说清楚**：设计文档第二段「不要移植那层抽屉外壳，用系统导航栈替掉它」
这条省钱路子，被这个目标关掉了。侧栏那层（`components/sidebar/**` + `app-sidebar.tsx`
4,258 行，加约 1,400 行被它用到的通用组件，全仓第二热）现在是**明确要付的**，
它从「M6 的背景」变成了 M3 之后的一个独立里程碑。

## 一轮怎么做

1. 仓库有多个兄弟会话共用，**动手前用 worktree 技能**拿独立检出，收尾 `land` 再
   `git -C ~/hermit-ui pull --ff-only`。
2. 从下面「下一项」里挑 **1–2 条**，不要贪。
3. 收尾必须过构建：`cd apps/ios && xcodegen generate` +
   `swiftc -typecheck -sdk "$(xcrun --sdk iphoneos --show-sdk-path)" -target arm64-apple-ios17.0 Hermit/*.swift Shared/*.swift`；
   动了 dashboard 再跑 `pnpm --filter @hermit-ui/dashboard typecheck`。不过就回滚并如实记下。
   **`swiftc -typecheck` 看不到 `HermitTests/`**，动了单测要另外真跑一遍：
   `xcodebuild test -project Hermit.xcodeproj -scheme Hermit -only-testing:HermitTests \
   -destination 'platform=iOS Simulator,id=<udid>' -derivedDataPath "$TMPDIR/hermit-ios-dd" \
   CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual PROVISIONING_PROFILE_SPECIFIER= DEVELOPMENT_TEAM=`
   （约 50 秒，首轮含全量构建约 2 分钟），跑完 `xcrun simctl shutdown all`。
   **别再用 `CODE_SIGNING_ALLOWED=NO`** —— 第 5 轮起 keychain 要签名才能用，见「踩过的坑」。
4. 改了看得见的界面才出截图（`tools/render-cards.sh` 只画 Live Activity 卡片，
   画不了 App 的屏；要 App 的屏就得上模拟器）；跑完确认
   `xcrun simctl list devices booted` 为空，并 `simctl erase` 掉自己开的那台。
   **需要一张真页面、但不想要 key 和网络**：`tools/bridge-fixture.sh`（第 4 轮加的）
   —— 把 `tools/bridge-fixture/server.py` 挂在 127.0.0.1 上，`-hermitOrigin` 指过去，
   跑一到三个 UI 用例，每个约 20–30 秒 + 一次全量构建。那个 server 既发静态页面，
   也答一条 `chat.listSessions`，并且**按 `x-asst-key` 给不同答案**（第 13 轮加的，
   原来是 `python3 -m http.server`）。
   模拟器进程就跑在这台 Mac 上，模拟器里的 127.0.0.1 就是这台 Mac 的 loopback，
   不需要任何端口转发。要验证桥、验证壳对页面的反应、验证原生屏的真实渲染，
   都从这里加，别去连真 dashboard。
   **迭代时设 `HERMIT_DERIVED_DATA`**（例如 `$TMPDIR/hermit-ios-dd`）：脚本默认跑完就删，
   设了它既复用增量构建、也不会被清掉，第二次起省掉约一分钟。
   **在 worktree 里跑，就把 `HERMIT_SHOT_DIR` 指到主检出**
   （`HERMIT_SHOT_DIR=~/hermit-ui/apps/ios/shots`）—— 否则 `wt.sh land` 删 worktree 时
   会把刚截的图一起删掉，见「踩过的坑」。
   **只想驱动原生网络层或数据层**（不要模拟器、不要 key、不要网络）：tRPC 那半用
   `tools/api-fixture.sh`（8 秒），SSE 那半用 `tools/stream-fixture.sh`（15 秒），
   本地库和搜索用 `tools/cache-fixture.sh`（4 秒），
   状态判定（`sessionStatusView` 的移植）用 `tools/status-fixture.sh`（2 秒），
   消息块的解码用 `tools/blocks-fixture.sh`（4 秒，第 18 轮加的），
   聊天头部那七个纯函数用 `tools/header-fixture.sh`（3 秒，第 5 轮加的）。
   两个都是假 dashboard + 一个 `swiftc` 直接编出来的驱动程序，会把「Swift 解出了什么」
   和「服务器真收到的请求行」两边都打出来。**它们不在任何 target 里，
   `swiftc -typecheck Hermit/*.swift` 看不见 `tools/`** —— 编不过只有跑一次才知道。
   **不需要 key、不需要网络的一屏**可以只跑单个 UI 用例，13 秒：
   `xcodebuild build-for-testing …` 然后
   `TEST_RUNNER_HERMIT_SHOT_DIR=$PWD/shots xcodebuild test-without-building … \
   -only-testing:HermitUITests/SmokeTests/<用例名>`。
   `shots/` 是 gitignore 的（截图不进仓库），所以 M7 那批要单独交给 sway。
5. **截图当证据要读像素**：`tools/pixel-probe.sh <png> [列比例] [步长]` 打一条竖扫描，
   相同颜色的段合并，像素和点一起印。别用 `sips --cropOffset`（它是相对图片中心的偏移）。
   端点色（255 / 10）永远精确，中间调要拿同一常量在另一条渲染路径上的读数比，见「踩过的坑」。
6. 回来更新这个文件：勾掉做完的、重写「下一项」、把踩到的坑写进最下面那节。

---

## M0 — 迁移保险（最高优先，不做会出事）

`dash.swaylab.ai` 后续并入 `hermit`。`AppConfig.origin` 原本是编译期常量，而麦克风授权是
`guard origin.host == AppConfig.host`（`WebViewController.swift:252`，**精确比对，不走
`isInternal`**）。迁移之后旧包麦克风直接 deny，网页侧 `canOpenMicSilently()` 在壳里返回
true，不会退回弹框。麦克风是这个 App 最初唯一的存在理由。

- [x] `AppConfig.origin` 改成 UserDefaults 里的值，默认仍是编译期常量；
      校验照抄 `apps/dashboard/src/lib/api-base.ts:28-44` 的 `normalizeBase()`
      （必须是裸 origin、非 localhost 必须 https）
      —— 第 1 轮。**两个键**，不是一个：`hermitOrigin` 只从 argument 域读、不校验
      （smoke.sh 要往它后面接路由，README 记着 LAN 上的 http 开发服务器）；
      `hermitOriginOverride` 存用户输入、过 `normalizeOrigin`。优先级
      launch argument > 用户设的 > `defaultOrigin`
- [x] 一个改 origin 的入口（先做最简单的：设置里一个输入框；不要为它建一整页）
      —— 第 2 轮。**两个入口**：离线屏的 "Change server" 按钮，和 `hermit://server`
      （`SceneDelegate.open(_:)` 里和 `hermit://session/<id>` 并列的第二个 case）。
      第二个是必须的：地址如果**答得出东西但不是 dashboard**，离线屏根本不出现，
      按钮就够不着。URL 不带地址，只是把对话框打开——任何 App 都能开 URL scheme。
      对话框是 `presentOriginEditor(prefill:)`：预填当前 origin，
      设过 `userOrigin` 才多一个 "Use default"，校验失败原样显示 `OriginError.message`
      并把用户打的字带回来
- [x] 改完 origin 要整个重来：tRPC / SSE / WS 三条连接全拆重建，等同冷启动
      （`docs/multi-deployment-design.md:42-51`）—— 第 2 轮，`WebViewController.switchOrigin()`：
      `bridge.pageWillReload()` → `AppConfig.setKnownHosts([])` → `LiveActivityManager.endAll()`
      → `webView.load(...)`。后两条不是顺手加的：`knownHosts` 是**上一个**页面报的，
      决定哪些链接留在 App 里；Live Activity 的推送令牌握在正要离开的那个部署的服务端手上，
      新页面无从知道它们存在，更别说结束它们
- [x] **`normalizeOrigin` 要拒掉 WebKit 的封禁端口** —— 第 3 轮。`AppConfig.blockedPorts`
      和 `api-base.ts` 的 `BLOCKED_PORTS` 各一份，**82 个数字、报错措辞逐字相同**
      （`backend address port 9 is blocked (browsers refuse to open it)`）。
      名单不是照着上面那行范围抄的：**上面那行是错的**，见「踩过的坑」。
      真名单是从一个活的 Fetch 实现里读出来的
- [x] `AppConfigTests.swift` 补对应用例 —— 第 1 轮，35 个用例真跑过（见「一轮怎么做」第 3 条）
- [x] **不要顺手**把麦克风判定放宽到 `isInternal` —— `knownHosts` 是页面报上来的，
      放宽等于把麦克风授权范围交给页面决定。要改的话判据是「用户自己配过的那个 origin」
      —— 第 1 轮复核：`WebViewController.swift:252` 原样没动，而 `AppConfig.host` 现在
      跟着用户设的 origin 走，正好就是「用户自己配过的那个 origin」这条判据

## M1 — 能力交接（页面不改）

- [x] **A0 桥加问答通道** —— 第 3 轮，两个方向都做了。
      `NativeBridge`：新的 `case "req"` / `case "reply"`、`onRequest` 闭包、
      `request(_:params:completion:)`、`pendingReplies` 待答表、`replyTimeout = 5`。
      `native-bridge.ts`：`nativeRequest()`（Promise，5 秒 reject）、
      `onNativeRequest()`（网页注册自己答哪些 method）、`NativeApi.onReply` / `.onRequest`。
      **还没有任何 method**：`onRequest` 是 nil，也就是「立刻回 unknown method」而不是沉默 ——
      老壳碰上新方法要 1 毫秒失败，不能让网页干等 5 秒。
      验收用例在 `HermitTests/NativeBridgeTests.swift`（真 WKWebView，不是假对象）：
      100 条并发问答乱序回答全部配对、答两次只送一次、超时走超时分支、
      `pageWillReload()` 当场废掉所有在途问题
- [x] **A0.1 第一个真 method，通道进产品** —— 第 4 轮。`WebViewController.answer()` 是
      整张方法表（一个 switch，刻意让「页面能让这个 App 做什么」是一份能一眼读完的清单），
      挂在 `bridge.onRequest` 上。两个方法：`getOrigin`（只读，回
      `{origin, defaultOrigin, isUserSet}` —— 页面自己知道 `location.origin`，
      不知道的是这个地址来自三个来源里的哪一个）和 `setOrigin`。
      **`setOrigin` 是「页面提议、人来拍板」，不是直接写。** 判据是麦克风：
      授权走 `origin.host == AppConfig.host` 精确比对，壳指到哪，哪个 origin 就
      拿到不弹框的麦克风、每次启动都拿。如果一次 XSS 就能写这个值，这个壳等于送出一个
      永久静默麦克风 —— 比同一个 XSS 在 Safari 里更糟，正好把这个 App 存在的理由反过来了。
      所以：地址不合法直接回错（**不弹框**，用户没打过的字不值得一个系统弹窗）；
      合法就弹 "Switch server?"，消息里把 旧地址 → 新地址 两行都写出来；
      确认了才 `setOrigin` + `switchOrigin()`。三个细节：
      `originConfirmation` 弱引用做单例闸门（页面循环调用会把弹窗摞到人点不完，
      底下的 App 就够不着了）；`url == AppConfig.origin` 直接回 `applied:false`
      （页面挂载时上报「我在哪」是很自然的写法，拿整页重载去回答它就是死循环）；
      **先回复、再切**（`switchOrigin` 拆掉的正是提问的那个 document，
      回复打进死页面等于让调用方白等满 5 秒；两跳都是 main queue，FIFO 保证回复先发出去）
- [x] **A1 Keychain** —— 第 5 轮。原生侧 `Hermit/Keychain.swift`（约 100 行，
      `kSecClassGenericPassword`、`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`、
      `kSecAttrSynchronizable = false`），方法表加 `keychain.get` / `.set` / `.clear`。
      **没有用 App Group**：跨 target 共享 keychain 要 `keychain-access-groups` 权限 +
      带这条的描述文件，而 widget 那边根本不需要 keyring（Live Activity 的内容全是推进去的），
      所以用 app 自己的默认组，等真有 target 要读再加。
      **账号（`kSecAttrAccount`）是 origin**，一个部署一条，这正是 localStorage 白送的隔离。
      判据不是弹窗（每次读都弹没人受得了），是**和麦克风同一条**：`webView.url` 必须和
      `AppConfig.origin` 精确同源才答 —— 不能用 `isInternal`，它连 `knownHosts` 也认，
      而 `knownHosts` 是页面自己报的、主框架又允许导航过去。
      网页侧 `keyring.ts` 的 `read()`/`write()` 改走内存副本 + `hydrateKeyring()`：
      Keychain 是异步的而 `getActiveKey()` 每个请求都要调，所以整份列表在文档存活期内
      放内存，Keychain 在后面写；`auth-gate.tsx` 在渲染任何东西之前 await 它。
      迁移顺序照做了：写入 → **读回逐字节比对** → 才 `localStorage.removeItem`。
      登出（列表清空）走 `keychain.clear`，不是存一个空数组
- [x] **服务端幂等键**（必须先于出站队列）—— 第 6 轮。`chat.send` 加可选 `clientId`
      （字符集限死 `^[A-Za-z0-9._:-]{1,128}$`，把 NUL 字节挡在 zod 而不是 INSERT 半路），
      `ChatMessage` 加 `clientId String?` + `@@unique([sessionId, clientId])`，
      迁移 `20260905090000_chatmessage_client_id`（**没在任何数据库上跑过**，见下）。
      **没有复用 `externalId`**：那一列是 `/api/sync/chat-message` 的 upsert 目标，
      客户端能写它就能占住一个 Anthropic 消息 id，让 agent 自己的转录行盖上来。
      命中重复时**整段提前返回**，不只是不插入 —— 下面每一件都是已经发生过一次的副作用：
      `QUEUE_LIMIT` 那个 count 会把「已经在队列里的那条」算进自己头上然后拒绝重试，
      `takeoverTurns` 会为同一句话给 Brain 记两次账，`endTakeover` 会再触发一次。
      归属校验留在提前返回**上面**（不能拿别人 session 的行当探针），而
      `closedAt` 检查留在**下面**：会话如果在原请求和重试之间关掉了，消息本来就在库里，
      「它落地了」才是实话；这里报错只会逼客户端换一个 `clientId` 重发，
      正好制造这个键要防的那条重复。并发两条一起来（都没命中查询、都去 INSERT）
      由唯一索引裁决，输的那条收 P2002、回读赢家那行、同样提前返回
- [ ] **A2 出站队列**：一个 append-only JSON 行文件即可，不要数据库。
      重试时机 `NWPathMonitor` + 回前台 + `BGAppRefreshTask`。
      **第 6 轮修正了两处**：（1）不需要 App Group —— 只有主 App 读写这个文件，
      widget 不发消息，放 App 自己的 Application Support 目录零权限就够，
      `Hermit.entitlements` 今天只有 `aps-environment`，不用动；
      （2）**真正的前提不是幂等键，是「谁来发这一次重试」**，见「下一项」
- [x] 红线文字更新 —— 第 5 轮，和 A1 同一个提交，**实际是 11 处不是 6 处**：
      `README.md`、`NativeBridge.swift` 两处、`LiveActivityManager.swift`、
      `HermitLiveActivityBundle.swift`、`AppConfig.swift`、`WebViewController.swift`
      （「dashboard 把 machine key 放 localStorage」那句注释）、`PrivacyInfo.xcprivacy`、
      `native-bridge.ts` 三处。统一改成「壳**不使用**凭据」而不是「壳**没有**凭据」：
      它现在存一份，但按 origin 存成一个不透明字符串，从不解析、从不自己发认证请求

## M2 — 原生网络层与数据层

- [x] `HermitAPI.swift`（第 7 轮，352 行）：tRPC over HTTP。
      `query` / `mutate` 各两个重载（有输入 / 无输入），泛型 `Out: Decodable`。
      成功读 `j[0].result.data.json`；失败先按 `j[0].error.json` 解析（拿到
      `UNAUTHORIZED: invalid key` 这种真句子），解不出来才退回 `HTTP <状态码>: <正文前 400 字>`，
      所以一张 nginx 502 的 HTML 页不会被当成 tRPC 错误。`URLError`**不包装**，
      原样往上抛 —— 断网/超时/取消各有自己的 code，调用方要能分开。
      `HermitAPIError` 另外给了 `isUnauthorized` 和 `isRetriable`（4xx 不重试，
      408 / 429 / 5xx / 0 重试），A2 的出站队列直接能用。
      会话是自建的 `ephemeral`：不带 cookie（认证只有 `x-asst-key` 这一条路）、
      不走缓存、`waitsForConnectivity = false`（断网必须立刻失败，重试由队列决定）、
      30 秒超时（和 gateway 一样）。
      **红线没动**：key 是构造时传进来的闭包，`HermitAPI` 自己不碰 Keychain，
      而且今天全仓没有一处构造它 —— 壳仍然不发任何带凭据的请求。
      **进度文件原来写的「照抄 `lib/keyring.ts:140-176`」是错的**，那段是 keyring 存取；
      现成的两份手写调用方其实是 `apps/gateway/src/api.ts` 和 `app/providers.tsx`
- [x] **superjson 的 meta 整块忽略**（第 7 轮，和上一条同一个文件）——
      `Batch.Success.Payload` 只声明 `json`，`meta` 连字段都不写。
      Date 用 `.custom` 解码策略，两个 `ISO8601DateFormatter` 依次试
      （带毫秒 / 不带）：superjson 出的是 `toISOString()` 一定有 `.000`，
      但 `/api/sync/*` 那些手写 payload 不一定，少一个 `.000` 不该整屏失败。
      安全前提复核过：`server/routers/` 里返回值没有 Map/Set/BigInt，
      输入侧 `grep -rn 'z\.date()'` **零命中**，所以编码方向永远不用发 `meta`
- [x] SSE 客户端 —— 第 8 轮，`Hermit/HermitStream.swift`（576 行，`HermitStream<Row>`
      泛型在行类型上，因为 M4 的消息 schema 还没定）。`URLSession.bytes(for:)`
      的字节流，退避 `[1s,2s,5s]`，35 秒僵尸看门狗，首连 `skipInitial=1`、重连不带。
      事件是 `connected` / `messages(rows:gone:)` / `status` / `frameDropped` /
      `disconnected(Error?)`，走一条 `AsyncStream`，**缓冲策略必须是 unbounded**：
      `delta=1` 的帧是增量不是快照，`.bufferingNewest` 丢一帧就在时间线上留一个洞。
      几个和网页不同、故意的地方：
      （a）**401 / 404 不重连**（`isRetriable` 复用 `HermitAPIError` 那份），
      网页是任何失败都无限退避重连，手机上那等于为了反复得到同一个答案耗电；
      （b）行是**自己按字节切的**，不是 `.lines` —— 见「踩过的坑」，这条是这一轮的真坑；
      （c）帧里 `data:` 多行按 SSE 语法拼接（网页只取第一行），两边不可能分叉，
      因为双方都用 JSON 编码器序列化，裸换行出不来；
      （d）不认识的 `event:` 名**静默跳过**而不是当成 messages 去解，
      新服务端加一种帧不该让老 App 刷一屏 `frameDropped`。
      顺带补齐两个帧类型：`SessionStatusFrame` / `SessionActivity`（照抄
      `server/session-status-frame.ts` 和 `lib/session-status.ts` 的字段），
      `activity` 单独 `try?` —— 那是一列不透明 JSON，它解不出来只该丢掉活动那一行，
      不该连 `state` 一起丢。`TimelineWindow.limit/digest` 抄自 `lib/chat-window.ts`，
      是下面「防漂移」的现成目标。**红线没动**：key 同样是构造时传进来的闭包，
      全仓仍然没有一处构造 `HermitStream`
- [x] `tools/stream-fixture.sh` + `tools/stream-fixture/` —— 第 8 轮，会真推 SSE 的假
      dashboard，约 15 秒，不用模拟器、不用 key、不用网络。四个场景由 `sessionId` 选：
      `s_frames`（所有帧形状 + 一个被拆成两个 TCP 包的帧 + 干净关闭后重连）、
      `s_silent`（开了就不说话，驱动看门狗）、`s_unauth`（401，证明它不重连）、
      `s_notstream`（200 但是 HTML，门户劫持）。服务端必须是 `ThreadingHTTPServer`：
      一条 SSE 连接会占住整个线程
- [x] **本地存储：SQLite + FTS5** —— 第 10 轮，M2 收尾。两个文件：
      `Hermit/SyncPlan.swift`（153 行，`planSync` 的移植）和 `Hermit/ChatCache.swift`
      （约 780 行，`libsqlite3` 直调，无第三方依赖）。
      **分词器选 `trigram`，不是 `unicode61`** —— 这不是查来的是跑出来的：同一份
      20,000 行中文语料上，`unicode61` 对**每一个**中文查询都返回 0 行
      （它把整句汉字当成一个词），`trigram` 与线性 `indexOf` 返回的行**完全相同**，
      检索耗时 0.0–0.3ms 对 1.8–2.5ms。
      **但 trigram 有一个洞，而且正好是常见情况：少于 3 个字符的查询它答不了，
      并且是静默地答 0 行**（「义脑」就是两个字）。所以 `canUseIndex` 一票否决，
      走和网页同一条线性扫描 —— 不是退步，只是没赚到。
      索引只负责**缩小范围**：它返回的每一行都在 Swift 里用网页那套 `indexOf` 规则重新
      核对一遍，片段和高亮偏移都来自这次核对，所以分词器折叠得比 JS 激进只会更慢、
      不会更错。片段偏移是 **UTF-16 码元**（网页切的是 JS 字符串，iOS 这边正好是
      `NSRange` 要的单位）。`SNIPPET_PAD` / `DEFAULT_PAGE` / `MAX_MATCHES_PER_ROW`
      三个数走上面那条防漂移的生成器，Swift 里没有手抄
- [x] **两张共享对照表 + 一个不用模拟器的驱动** —— 第 10 轮。
      `apps/ios/tools/fixtures/sync-plan-cases.json`（22 例）和 `search-cases.json`
      （22 例 + 10 行语料）都是**跑真的 TypeScript 生成的**
      （`scripts/gen-sync-plan-fixture.ts` / `gen-search-fixture.ts`），
      `src/lib/chat-cache/sync-plan-fixture.test.ts` 4 条断言保证它们不过期。
      `tools/cache-fixture.sh`（约 4 秒，不用模拟器/key/网络）把两张表跑一遍、
      量一次分词器、再验一次索引与表是否一致，共 502 条检查
- [x] **防漂移** —— 第 9 轮。`apps/ios/Shared/WebContract.swift` 现在是**生成的**
      （`apps/dashboard/scripts/gen-ios-contract.ts`，`pnpm --filter @hermit-ui/dashboard
      gen:ios-contract`），十四个成员：时间线窗口、退避与看门狗、三个 Live Activity 超时、
      两条 ctx 分档、七个颜色。三个手写文件改成读它（`StatusPalette` / `HermitStream` /
      `LiveActivityManager`），**Swift 侧一个数字都不剩**。
      **那处漂移修好了**：`workingStaleAfter` 由 10 分钟变成服务端的 15 分钟
      —— 症状是长工具调用跑到第 10 分钟锁屏卡片自己变暗，下一次推送又亮回来。
      颜色不是抄的：`session-status.ts` 和 `ctx-bar.tsx` 里出现的 Tailwind 类名被读出来，
      拿 `tailwindcss/theme.css` 解析成 oklch，再转 Display P3，所以网页加一个颜色
      这边就多一个常量。`apps/dashboard/src/lib/ios-contract.test.ts` 7 条断言
      （`pnpm test` 已经在跑这个目录）：生成物与现在渲染的逐字节相同、
      oklch→P3 与手写时期的七个值对得上、Swift 引用的成员都还在、
      手写文件里没有复活的字面量、两边的 ctx 分档映射到同一个类名、
      状态点用的类名 iOS 都有。**这些断言被反证过**（见「踩过的坑」）

## M3 — 前门

- [x] `UINavigationController` 当根容器 —— 第 11 轮。栈里今天只有 `WebViewController`
      一个，导航栏 `isNavigationBarHidden = true`（页面自己画头部）。三处强转合并成一个
      `private var web: WebViewController?`：它**在栈里找**，不再假设网页就是根。
      那三处漏改不会报错，只会安静地做错事 —— 深链接打不开、Live Activity 点进去落错屏、
      离开前台不放音频会话（麦克风指示灯一直亮）。先单独把容器换掉、不带任何新界面，
      是为了让「安全区多了一层」「状态栏样式变了」「手势被抢」这类问题自己冒出来，
      而不是混在一个同时画新屏的提交里
- [x] **`sessionStatusView` 移植成 Swift** —— 第 11 轮，会话列表的前提，不是它本身。
      `Hermit/SessionStatus.swift`（441 行）把 `lib/session-status.ts` 的判定阶梯、
      `shortDuration` / `activityLabel` / `backgroundSummary` / `backgroundTaskList` /
      `backgroundStillRunning` / `snapshotSilenceMs` 一并移过来；`SessionActivity`
      从 `HermitStream.swift` 搬到这里（定义它的是 session-status.ts，流只是运它）。
      **`StatusView.dot` 保留网页的 Tailwind 类名原文**（`bg-amber-400/50`），
      对照表因此能逐字节比；类名转颜色只有一处，`StatusPalette.dot`，
      `/50`、`/30` 那个百分比不能丢——它是「在跑但没动」和「在跑」的唯一区别。
      两个阈值 `SNAPSHOT_STALE_MS` / `BACKGROUND_RESIDENT_MS` 并入第 9 轮的生成器
      （毫秒，不是秒：这个移植保留原函数的时钟单位）
- [x] 原生会话列表：`UICollectionView` + `UIHostingConfiguration` —— 第 12 轮。
      `Hermit/SessionRowView.swift` 是行视图（纯 SwiftUI + 一个值类型，不 import UIKit），
      `Hermit/SessionListViewController.swift` 是列表，`Hermit/SessionListItem.swift` 是行数据。
      **没有复用 `LiveActivity/SessionCardViews.swift`** —— 那是锁屏卡片的排版（大字号、
      计时器、按钮），侧栏的行是 13px 标题加一行 10px 等宽副标题，共用只会两边都拧着。
      共用的是判定和颜色：`SessionStatus.view` 出 dot/label/pulse，`WebContract` 出颜色。
      入口是 `hermit://sessions`（推进栈），**还不是前门** —— 见下一条
- [x] 只发**一个** tRPC 查询 `chat.listSessions` —— 第 12 轮。服务端已按
      `sessionRecencyMs` 排好并截到 200，Swift 侧原样渲染、一次都不重排。
      **第 13 轮在模拟器上真跑过**：上面这两条到那一轮为止只在 Mac 上编译和渲染过，
      现在 `tools/bridge-fixture.sh testTheNativeListDrawsTheActiveMachinesSessions`
      会把假页面存的两条 keyring 装进 Keychain、指定第二条为活动、开 `hermit://sessions`，
      而假服务端**按 `x-asst-key` 给不同的答案**，所以第一行的标题就是壳挑中的那台机器。
      三张截图 `shots/16..18`
- [x] **自己刷新，且只在你看着它的时候刷新** —— 第 14 轮，前门那一条的前提。
      网页侧栏是 `refetchInterval: 5_000`，并且标签页切走就停（React Query 的
      `refetchIntervalInBackground` 默认 false）；两半都照抄了：`viewWillAppear` 起
      5 秒定时器（`tolerance = 1`）、`viewWillDisappear` 停，
      `didEnterBackground` 停 / `willEnterForeground` 立刻拉一次再起。
      **轮询把一个原来看不见的 bug 逼出来了**：diffable 的标识符原来是行值本身，
      而 `SessionListItem` 对所有字段 `Hashable`，所以「同一条会话、晚一秒」是另一行 ——
      每 5 秒整列表删了重插。改成按 `id` 做标识符、变了的行 `reconfigureItems` 原地重画。
      在飞的请求不会被轮询挤掉（否则超过 5 秒的请求永远落不了地），
      但下拉刷新和回前台会顶掉它；**轮询失败不动屏幕上已有的列表**，和网页一样
- [x] **首屏的等待指示** —— 第 14 轮，同一提交。`Hermit/SessionListSkeleton.swift`
      就是 `recent-lists.tsx` 那六条 `h-8 rounded-md bg-sidebar-accent/40 animate-pulse`，
      纯 SwiftUI 所以 `tools/render-list.sh` 能画（多出两张 `session-list-loading-*`）。
      空态和错误文案改成网页的排版（`px-2 py-2 text-xs text-muted-foreground`、
      左对齐贴在标题下，不是居中），空列表的句子也换成网页原文
      `no chats yet — start a New chat.`
- [x] 冷启动先画本地快照，同时后台预热 WebView —— 第 15 轮做的，
      **第 4 轮 perfect-goal 把「列表当根」那半退回去了**：网页重新是栈底，
      列表退回 `hermit://sessions` 后面（见本节最后一条）。快照、预热、`AppShell.openPath`
      三件都留着，改的只是 window 打开在哪个 view controller 上。
      快照不在 App Group 也不在 `ChatCache`，是 `Hermit/SessionListCache.swift`：
      Application Support 里**每个 keyring 条目一个 JSON 文件**，20 秒写一次节流，
      空列表读回来当没有 —— 逐条对着 `lib/session-list-cache.ts` 移的。
      不用 `ChatCache` 的理由写在那个文件的头注释里：它按**工作区**（机器 id + agent 名）
      分库而这里按 keyring **条目**分，而且开库要跑迁移和 `CREATE VIRTUAL TABLE … fts5`,
      这条路要在第一帧之前跑完，老系统上那个 CREATE 失败就把前门一起带走。
      **没签过名的人仍然直接进网页**：keyring 是空的时候冷启动立刻无动画 push 网页，
      因为登录闸门和「换服务器」都是网页 —— 和 dashboard 自己的根路由同一条规则。
      三件事都落了地：**(a)** 快照，**(b)** 深链接/通知/Live Activity 改走
      `AppShell.openPath`（`AppDelegate` 不再拿得到 `WebViewController`，见「踩过的坑」），
      **(c)** 返回是边缘手势，导航栏在网页那一屏仍然隐藏。
      列表多了一个 `New chat` 按钮（`/chat?new=1` + square.and.pencil，抄
      `components/app-sidebar.tsx`）—— 空态那句「start a New chat.」原来指向的是空气，
      而且它是从前门进网页的唯一一条路。点开的那一行现在会高亮（`activeSessionId`，
      对应网页的 `optimisticActiveId`）
- [x] **像素比对流程** —— 第 16 轮，走的是「下一项」里的路线 (a)。
      `tools/pixel-compare.sh` 一条命令 33 秒出结论，不用模拟器、不用 key、不用数据库：
      画一次原生（`render-list.sh`）、画一次网页（`render-web-list.sh`）、逐像素比
      （`tools/png-diff.swift`），三张图和一张热力图落在 `apps/ios/shots/`。
      网页那半是 `apps/dashboard/scripts/render-session-rows.tsx`：`react-dom/server`
      渲染**真的那个行组件**，把 `@tailwindcss/postcss` 编出来的 CSS 内联进一张 HTML，
      再用 `/Applications` 里的 Chrome `--headless=new` 截图。
      为此把 `SessionRow` 从 `recent-lists.tsx` 抬进 `components/sidebar/session-row.tsx`
      —— 原文件 import 时就要 trpc 客户端和 Next 的路由 hook，裸 Node 里活不下来；
      而在测试台里照抄一份行的 markup，等于拿移植去比另一份移植，永远自洽。
      两边吃同一份 `tools/fixtures/session-rows.json`（11 行，时间写成「多少秒之前」），
      并且共享同一个 `HERMIT_FIXTURE_NOW`，所以「12s ago」这一列不会因为两次截图差一秒而变红。
      **第 17 轮把行对齐了：10.10%/10.03% → 4.33%/4.29%**，而且不再逐行累积。
      三件事：行高从 43 改成网页的 48.5（`RowMetrics`，见「踩过的坑」）、
      行与行之间补上 `space-y-px` 的 1pt、选中行的圆角从 `.continuous` 换成 `.circular`。
      顺带给 `render-web-list.sh` 加了 `HERMIT_MEASURE=1` —— 打印 Chrome 自己量出来的
      每个元素的盒子，M6 每一屏都会先用它
- [x] **前门退回网页的形状** —— 第 4 轮 perfect-goal。`SceneDelegate` 的根改回
      `WebViewController`，`hermit://sessions` 从 `popToRootViewController` 变回一次 push。
      第 15 轮那三样一样没丢：网页实例由 `SceneDelegate` 强持有、深链接/通知/Live Activity
      仍走 `AppShell.openPath`、`SessionListCache` 照旧。
      **列表也改成 `SceneDelegate` 持有的单实例**（原来是每次 `hermit://sessions` 新建一个）
      —— `activeSessionId` 长在它身上，重建一个就等于每次回来都忘了你点的是哪一行，
      而那正是网页的 `optimisticActiveId`。
      `presentList` 是 `setViewControllers([web, list])` 而不是「先 pop 再 push」：
      列表在网页上是盖在会话上的抽屉，不是栈里的第三层，所以从时间线开它读作
      「给我看会话列表」而不是「你现在三屏深」；一个 runloop 里起两次带动画的导航转场
      正是 UIKit 那句 unbalanced begin/end appearance transitions 的来处。
      UI 用例 `testTheSessionListIsTheFrontDoor` 改写成
      `testTheWebAppIsTheFrontDoorAndTheListIsBehindIt`，反证过（见「踩过的坑」）
- [ ] **原生抽屉**：整个侧栏 —— 机器选择器、市场入口、NAV 4 项、brain 6 项、
      最近会话 / agent / cron 三列、footer（`components/sidebar/**` + `app-sidebar.tsx`
      4,258 行，加约 1,400 行被它用到的通用组件，全仓第二热）。
      `SessionListViewController` 就是它「最近会话」那一列的内容，已经写好了。
- [ ] **抽屉的手势吃网页那组数**：`W=280`、`EDGE=28`、`SLOP=10`、`EDGE_SLOP=5`、
      `FLICK=0.3 px/ms`、`STALE_MS=80`，照 status / blocks / fold 的老套路从
      `use-drawer-swipe.ts` 导出成共享夹具，别手抄。
- [ ] **网页那半的抽屉要能被壳关掉**（native-bridge 再加一个开关）：
      否则两个抽屉同时存在、边缘手势打架。**在它完整之前不要切换** ——
      半个抽屉比今天这个 URL 后面的全屏列表更不像网页。

## M4 — 时间线（最贵的一块）

- [x] **消息块的真 schema**（先于一切渲染）—— 第 18 轮。`apps/dashboard/src/lib/chat-blocks.ts`
      是唯一那份定义，**故意分成两半**：`WireContentBlock` 只校验、原样交还写进去的对象
      （写入口要的就是这个：生产者发来一个比本次部署新的块类型，也得能连键带值存下来），
      `parseBlocks()` 是读的那一面 —— 一个渲染器能 switch 的判别联合，unknown 那支是显式的。
      **联合是「不可能失败」的**：那一列里已经躺着四个生产者一年里写进去的 54 万行，
      能拒掉其中一行的 schema 就是让历史画不出来 —— 所以匹配不上任何已知变体的块变成
      `unknown` 并带着生产者自己那个 type 字符串，既不报错也不丢块。这正好是 M4 最后一条
      「不认识的块画成写着类型名的灰卡片」要的东西。
      Swift 那半是 `apps/ios/Hermit/ContentBlock.swift`（**只依赖 Foundation**，
      时间线可以建在它上面而不把视图层拖进每一次解码）。
      两边吃同一份 `tools/fixtures/block-cases.json`，见 `tools/blocks-fixture.sh`。
      **顺带发现：`routers/chat.ts:41` 那个「宽松联合」是死代码** —— 声明了，
      没有任何一个 procedure 引用过它，也就是说今天任何写入路径上都没有块级校验
      （真正的入口 `/api/sync/chat-message` 校验到 `string | unknown[]` 为止，那是刻意的）。
      网页端改用它的地方挑了不花代价的三处：`chat.send` 现在**以 `WireContentBlock` 的身份**
      拼块（编译期就管住），`extractSearchText` 和 `msgText` 换成共用的那个读法。
      时间线自己的组件仍留着宽松的 `Block`，理由写在 `components/chat/lib.ts` 的注释里
- [x] **`foldRuns` 移植成 Swift** —— 第 19 轮。`apps/ios/Hermit/FoldRuns.swift`（只依赖
      Foundation），连同 `isMachineryBlock` / `closesRunUnconditionally` / `safeSplitIndex` /
      `summarizeRun` / `isHarnessTerminator` 和「运行块按它下面那行取名」的第二遍。
      夹具 `tools/fixtures/fold-cases.json` 由 `scripts/gen-fold-fixture.ts` 跑真函数生成，
      驱动是 `tools/fold-fixture.sh`（29 组折叠 + 23 + 13 + 11 + 6 组单点，**97/97**）。
      **它折的是原始块，不是 `parseBlocks()` 的结果**，这一条和上一轮写在「下一项」里的
      打算相反，理由见「踩过的坑」——照那个打算做会让同一段会话在手机上和网页上折得不一样。
      两条附带的性质也在夹具里：任意安全接缝处分两半折 == 整体折（11 个接缝逐个验），
      以及**摘要后的内容折出来的折叠态，和网页用完整内容折出来的逐字段相同**
- [ ] markdown 渲染：GFM 表格、围栏代码、14 种语言高亮（bash css diff go javascript
      json markdown plaintext python rust sql typescript xml yaml）。
      **没有数学公式、没有 mermaid** —— 这是省下来的范围。
      **sway 09-05 15:40 点头了：「可以装第三方依赖」**，所以「零第三方依赖」这条性质到此为止，
      不用再为它绕路。选型的准绳仍然是那句「和网页完全一致」，网页那半是
      `react-markdown` + `remark-gfm` + **`remark-cjk-friendly`** + `rehype-highlight`
      （即 `highlight.js`），主题是 `globals.css:162-260` **手写的**一套 `.hljs-*` 规则。
      由此有两条路，**先花一轮各画一屏、逐像素比，再定**（别凭直觉挑）：
      **(a) 全 Swift**：`swift-markdown`（Apple，cmark-gfm）+ 一个 Swift 高亮器。
      干净、无 JS，但两处必然对不上：`remark-cjk-friendly` 那条中日韩强调规则 cmark 没有
      （`**中文**紧跟标点` 这类会分歧），以及换掉 highlight.js 就等于换了一套分词，
      而颜色表是按它的 class 名写的。
      **(b) 解析和高亮都用网页那两份 JS**，在 `JavaScriptCore` 里跑（不是 WebView），
      Swift 只把 AST 画成原生视图；颜色表照 `gen-ios-contract.ts` 的老套路从 `globals.css`
      直接生成。一致性最强、网页以后改了重新打一次 bundle 就跟上，代价是包里多一个 JS bundle
      和一次冷启动的执行开销 —— **两者都要量出来写进这个文件**（bundle 体积、首次高亮耗时、
      长消息滚动时的帧）。
      不论走哪条，测法不变：拿真实消息里最长最花的那几条做夹具，两边吃同一份
- [x] **倒置 `UICollectionView` 的时间线骨架**（每个 cell 也翻转）—— 第 20 轮。
      `apps/ios/Hermit/TimelineRowView.swift`（纯 SwiftUI，画一个 `FoldedRow`）+
      `apps/ios/Hermit/ChatTimelineViewController.swift`（`collection.transform` 竖向翻转、
      每个 cell 翻回来、diffable 按 `FoldedRow.key` 索引、`chat.listMessages` 取
      `WebContract.timelineLimit`/`timelineDigest` 那一个窗口）。翻转买到的两件事写在类注释里：
      「贴着最新一条」就是 contentOffset 0，而**加载更早的历史变成了 append** ——
      网页为「在顶部插入而不跳动」花掉的是 `use-prepend-anchor.ts` 整整 514 行。
      **还挂在 URL 上、不是前门**：`hermit://timeline/<id>`，和当初引入原生列表同一个做法；
      列表里点一行仍然进网页 chat 页，要等 M5 有输入框才该换。
      **第 3 轮（perfect-goal）第一次把它装到模拟器上，四个只有真机能看见的 bug 全在那一次里**：
      cell 的翻转被 `apply(_:)` 覆盖（整屏上下镜像）、安全区插在反的一端、
      `scrollViewDidScroll` 里同步 apply 快照会崩、iOS 26 的 scroll edge effect 被翻转带反
      （整屏冲淡到读不了）。四条都写在「踩过的坑」里
- [x] **「更早」这条路通了** —— 第 2 轮（perfect-goal）。`chat.listMessagesBefore` 一页
      `WebContract.olderPage` 行，`LoadEarlierPill` 是网页那颗 `↑ load earlier` 药丸
      （连 `loading…` 和 `disabled:opacity-50` 一起），滚到离尽头不足两屏自动拉
      （`pullMargin`，两屏跑道、有下限）。倒置之后这是 append：网页为「顶部插入不跳位」
      写了 `use-prepend-anchor.ts` 514 行，这边一行都不用。
      屏幕现在拿着**两个列表** —— 直播窗口和它下面的历史 —— 而两者会自己不再接壤，
      所以 `Hermit/TimelinePager.swift` 把 `shedRows` / `shouldKeepShed` / `absorbShed`
      也移植了（同一张夹具，`tools/merge-fixture.sh`）。**没有移植 `chunksBottomFirst`**，
      理由写在文件头：它买的两件事在倒置的 collection view 上都不存在
- [x] **时间线的头** —— 第 5 轮 perfect-goal。`Hermit/ChatHeaderView.swift`，
      照 `app/chat/page.tsx` 那个 `h-12 px-4 border-b border-border` 的头做：
      标题（`chatHeaderTitle` 的四级回退）+ 元信息行（agent · 状态点和标签 ·
      后端 · ctx 迷你条 · closed）。导航栏在这一屏改成**隐藏**，因为网页那个头是不透明的，
      而第 3 轮关掉 scroll edge effect 之后半透明导航栏底下什么都没有、最老一行会穿过标题。
      数据是 `chat.getSession` 自己的 5 秒轮询（列表那条 `listSessions` **故意不带**
      `activity`，所以「Bash · 47s」只可能来自这条），外加 `event: status` 帧走
      `SessionStatus.merge`（`mergeLiveStatus` 的移植）抢在轮询前面 ——
      **这是 `event: status` 第一次有消费者**。
      新移植的七个纯函数（`fmtBytes` / `ctxPct` / `ctxFill` / `contextWindowFor` /
      `runtimeShortLabel` / `providerMark` / `chatHeaderTitle`）配 `tools/header-fixture.sh`，
      `mergeLiveStatus` 进了 `tools/status-fixture.sh`
- [ ] **头部右侧的动作簇**：新建会话、终端（有 tmux pane 才有）、删除（`ConfirmIconButton`）、
      归档会话的「恢复」，加上手机上那个溢出托盘里的五个（pure chat / 会话详情 /
      查找 / compact / restart）。今天右侧是空的
- [ ] **模型胶囊**（`modelChipLabel` + `chat.setSessionModel` + 那张模型目录）——
      条件是**不是分享链接**，且 `codex-exec`，或者 `claude-sdk` 且没有凭据。
      codex 那一半是 09-05 19:07 才加的（`f14567d8`），目录来自网关读 `models_cache.json`
      推上来的那张表，和 claude 的 `supportedModels()` 不是同一条路
- [ ] **点标题改名**（`chat.setTitle`）+ 那颗重新生成标题的 `Sparkles`（`chat.autoTitle`）
- [ ] **状态胶囊和后端胶囊点开会话详情面板**（`chat.sessionDetail`）——
      网页上这两个都是按钮，手机没有 hover，面板是那句被截断的状态唯一能读全的地方
- [ ] `nextId` 空洞证明 + 本地缓存直接供页（`lib/chat-cache/types.ts:47-68`、
      `use-older-pages.ts` 的 `pageBefore`）—— 翻页现在每一页都问服务端。网页在本地存储
      **能证明**自己握着一段没断过的链时直接供页；那个证明读的是 `full` / `digest` 两个行存储，
      而 `ChatCache` 今天只有 prose 那一层。**先加存储，再移植证明** —— 反过来做，
      就是一个没有调用方的纯函数
- [ ] 两级保真：digest / full，展开胶囊时 `chat.getMessages` 取真实体
- [ ] 交互卡片：`kind: permission | question`，`status`、`decision`、`answeredBy`
- [ ] 图片 / 文件块 + lightbox（`QLPreviewController`）
- [x] **不认识的块类型画成写着类型名的灰卡片**，不能画成空白 —— 第 20 轮，
      `TimelineRowView.BlockView` 的 `.unknown` 分支，卡片上印的就是生产者自己那个 type
      字符串（截图里那张写着 `sink_deliverable`）。`type` 是空串的（那个块根本不是对象）
      印 `unrecognised block`，不留一个没标签的框。同一条纪律往外铺了一层：
      这个 switch 的**每一支都画点什么** —— tool_result、interaction、image、file
      现在都是带标签的占位卡或者一行 chip，等各自那条清单来换掉

## M5 — 输入框

- [ ] 附件（`/api/upload` multipart，20 图 / 10 文件上限，用返回的 **safe** url）、
      草稿（`hermit:draft:<sid>`，每次按键都写）、队列条（`QUEUE_LIMIT=5`）、
      停止胶囊（独立的一颗，**不要和发送做在同一块像素上**）、↑↓ 走历史、
      Enter 发送 / Shift+Enter 换行、输入法组字期间不发送
- [ ] 按住说话：`HOLD_MS=260`、`BAIL_PX=10`、`SLIDE_PX=64`，三个区是
      发送 / 左划取消 / 右划落回输入框（**没有「转文字」这个区**）
- [ ] 听写：`/api/asr/<sid>` WebSocket，鉴权走 `Sec-WebSocket-Protocol: hermit-key.<token>`
      （原生可以直接设 header，但服务端认的是 subprotocol）。上行 16kHz 单声道 PCM16
      二进制帧；下行 `partial` 整段重写、`final`/`polished` **乱序到达，按 segId 定位**
- [ ] **没有斜杠命令、没有 @ 提及、没有已发消息的编辑** —— 网页端就没有，别自己加

## M6 — 其余页面

按 `lib/settings-nav.ts` 的 13 个设置 tab + `app-sidebar.tsx:29-51` 的 NAV 4 个 +
brain 6 个，逐个原生化，每个都过一次像素比对。建议顺序（便宜且稳的先走，
用来把 M3 那套比对流程磨顺）：

- [ ] `/market/templates`（近 90 天 0 提交）、`/help`（零网络调用）、
      `/appearance`（零 tRPC）、`/ops`、`/knowledge`、`/notifications`、`/trash`
- [ ] `/watchdogs`、`/models`、`/backends`、`/usage`（那个「图表」是 div 加 height，
      不是图表库，Swift Charts 反而更少代码）、`/file-station`
- [ ] `/agents`（第二热，64 提交 / 90 天；`agent-detail-sheet.tsx` 1,193 行，
      建议名单页先原生、详情表单后做）、`/skills`、`/market/skills`、
      `/system`、`/global-memory`、`/brain/*` 六个
- [ ] `/chat/terminal` **建议保持网页**（xterm.js + 一条裸 WebSocket，近 90 天 3 个提交、
      净增 5 行；原生 VT100 是几周的活，换来零收益）。**这条要 sway 点头**

## M7 — 收尾

- [ ] 装到模拟器上从头到尾走一遍，每屏截图存 `apps/ios/shots/`
      —— **时间线那一段第 3 轮走完了**（`tools/bridge-fixture.sh` 的
      `testTheNativeTimelineStreamsAndPagesBack`：深链接 → 窗口 → 流回来 → 往回翻两页 →
      药丸退休，六个用例一起 0 failures）。剩下的是网页那几屏和输入框，
      所以这条不勾
- [ ] 文档更新：`apps/ios/README.md` 的「Everything else is the existing web app,
      unmodified」、`docs/ios-shell-design.md:5` 的 non-goals

---

## 下一项（下一轮从这里开始）

> 2026-09-05 16:35 起，这个清单由 `perfect-goal` 的轮次驱动，轮次日志在
> `~/agents/asst/projects/ios-native/goal/ROUNDS.md`，目标与验收标准在同目录的 `GOAL.md`。
> 目标未变：把这个清单清空。**清单 33/56** —— 分母涨了 5：第 5 轮做完时间线的头
> （勾掉一条），并把这个头**还欠着的四件**（右侧动作簇 / 模型胶囊 / 点标题改名 /
> 两个胶囊开详情面板）写成明写的清单项。都是「全部复刻网页」躲不掉的，
> 留在散文里只会让清单先清空、活后干完。

**第 1 条：M5 输入框。** `GOAL.md` 验收标准 2 里只剩这一块没做：
读得到、会自己长、翻得动、头也有了，发不出去。做完了列表点一行才该换成进原生时间线。
先做最小的那一半（草稿、`chat.send` + 幂等键、乐观气泡、发送中的停止胶囊），
附件 / 按住说话 / 听写各自是独立的清单项，别一轮全吃。

**第 2 条：本地行存储 + `pageBefore`。** `ChatCache` 今天只有 prose 一层，
所以翻页每一页都问服务端，而网页读过一遍的历史是零网络的。加 `full` / `digest` 两个行存储
（带 `nextId`），`pageBefore` 才有调用方，`ChatCache` 欠的「两级保真」也一起解掉。

**第 3 条：头部右侧的动作簇。** 现在右边是空的。做它等于把 `chat.createSession` /
`deleteSession` / `reopenSession` 这几条 mutation 一次性接进原生，
所以它也是 M5 之外第一条真正会**写**服务端的活。

**抽屉原生化是 M3 末尾三条明写的清单项**，比上面几条都大，排在它们后面：
时间线是 `GOAL.md` 验收标准 2 点名的那一屏。

**markdown 那一条随时可以开**（M4 第三条）：sway 已经点头可以引第三方依赖，
两条候选路要**先各画一屏逐像素比再定**。骨架把位置留好了：换掉 `TimelineRowView` 里
`ProseText` 那一个 `Text` 即可。

**时间线骨架自己欠的三件（都写在代码注释里，不急）**

1. **胶囊点不开。** `▸` 画着，但没有展开态，也就没有 `chat.getMessages` 那条取全量的路
   （M4 第五条）。展开态是往 `RunCapsuleView` 底下加一段。
2. **图片/文件是一行 chip，不是 `file-preview.tsx`。** 真的缩略图和 lightbox 是 M4 第七条。
3. **行距用的是 `.lineSpacing`，不是真的 CSS 行盒。** `TimelineMetrics` 记着网页每一档的
   `line-height`，但 SwiftUI 只能调行间距、调不了首行的行盒高度。
   **M6 给这一屏跑第一次像素比对之前，得先决定这里用哪种做法** —— 会话行是一行文字所以
   能用 `.frame(height:)` 钉死，一段可换行的正文钉不住。

**比对流程自己的两件（第 18 轮量出来的，原样有效）**

1. **真列表的行距是 52.33pt，像素比对画的那张是 49.5pt** —— 差 2.83pt，11 行完全均匀不累积。
   `tools/pixel-compare.sh` 结构上看不见这一段（它画孤立的一行，真列表是
   `UIHostingConfiguration` 里的一个 cell）。`render-timeline.sh` 画的同样是脱离 cell 的一列。
   M6 开工前值得花十分钟定位。
2. `gen-ios-contract.ts` 直接生成混好的半透明色（Tailwind v4 的 `/50` 走
   `color-mix(in oklab, …, transparent)`，Swift 这边是 `.opacity(0.5)` 直接混，差 9–12/255）。
   alpha 那条路第 20 轮已经通了，剩下的是把 `color-mix` 也算进去。

**仍然欠着的小事**

1. ~~地址填错、但设备上还留着 keyring 时，前门是一张加载失败的列表。~~
   第 4 轮消失了：前门又是网页，地址答不出东西就是离线屏，上面有 "Change server"。
2. ~~`hermit://sessions` 的语义变了：现在是 `popToRootViewController`。~~ 第 4 轮变回 push。
3. 相对时间不会自己走（列表和时间线都是）；浅色模式下骨架屏几乎看不见，见「踩过的坑」。
4. `chat.send` 的幂等键现在可以真的驱动了（本机有 Postgres 了）。

**部署纪律不变**：`20260905090000_chatmessage_client_id` 那个提交和
`pnpm --filter @hermit-ui/dashboard migrate` 必须一起上线，先上代码后跑迁移会让部署上的
`chat.send` 整个坏掉。索引是全表扫，建的时候挡写不挡读，挑个没人聊天的时候。
连接串 `postgresql://znmacserver001@localhost:5432/hermit_dev`，**worktree 里没有 `.env`**，
独立检出里跑 Prisma 要显式带上它。

**要 sway 拍板的：一件都不剩。** 09-05 15:05 那句「要和网页交互和 UI 保持完全一致」定了三件
（左边缘归网页抽屉、`/chat/terminal` 保持网页、Geist Mono 塞进包里），
15:40 那句「可以装第三方依赖」定了第四件（markdown 可以引依赖）。
16:5x 那句「全部复刻网页，做完再评审，反复改到完美」把范围定死成全量，见 `GOAL.md`。

## 踩过的坑

### worktree 里跑 `tsc` 之前一定要先 `prisma generate`（第 5 轮，第三次）

第 16 轮和第 19 轮各记过一次，这一轮又踩了 —— **land 之后为了跟一次别人的改动重新
`enter` 了一个新 worktree，然后只补了 `node_modules` 软链、忘了 `prisma generate`**，
于是 `tsc` 吐出两百多条 `Cannot find module '@/generated/prisma/client'` 和一片
`implicitly has an 'any' type`，一条都不是自己造成的。
新 worktree 的完整配方是**三步，缺一不可**：
`ln -sfn ~/hermit-ui/node_modules $WT/node_modules` →
`cd $WT/apps/dashboard && DATABASE_URL="postgresql://x:x@127.0.0.1:5432/x" $WT/node_modules/.bin/prisma generate` →
`$WT/node_modules/.bin/tsc --noEmit`，跑完 `rm -f $WT/node_modules`。
**一轮里 land 过一次就等于换了一个 worktree**，这三步要重来。

### 一轮跑完 land，别人的改动可能正好落在你移植的那个函数上（第 5 轮）

第 5 轮 land 完 `pull`，带回来兄弟会话的两个提交，其中一个给
`lib/context-window.ts` 的 codex 表加了 `gpt-6` 一行 —— 正是这一轮刚移植成 Swift 的那张表。
所以 **land + pull 之后要在合并后的检出上把闸门重跑一遍**，而且是「重新生成夹具表再跑」，
不是只跑 `swiftc`：表是从网页那份代码生成的，网页动了表就该动。
这次补上 `gpt-6` 之后 128/128。
**但反证说明这条抓不到**：codex 表里除了 spark 那行，其余每一行都是 258,400，
和 fallback 一样，删掉哪一行夹具都还是绿的。那张表今天是**记账**，
等哪天某个窗口不等于默认值，它才开始有牙齿 —— 两边的注释都写了这句。

### SwiftUI 的 `.frame(maxWidth:)` 是贪婪的，它不是 CSS 的 `max-width`（第 5 轮）

网页那行元信息用 `max-w-[9rem]` 给 agent 名字封顶，**内容多短就多短**，只有溢出时才收缩。
Swift 照抄成 `.frame(maxWidth: 144, alignment: .leading)` 的行为**正好相反**：
它会把行里所有余量吃掉。结果是四个字母的 `asst` 后面留出一百点的洞，
而挨着它的状态标签「Bash · 47s」被挤成了「4…」。
判据只有出图才看得见 —— 六条断言全过，字都在，只是排布是错的。
今天的做法是把两个上限**去掉**：一行纯 `Text` + `lineLimit(1)` 本来就是非贪婪且可压缩的，
而在手机宽度上那两个上限**永远够不着**（留给它俩的大约 175pt，压缩先到）。
iPad 上才够得着，而 `GOAL.md` 说的是「iPhone 上的 Hermit」。

### `toFixed` 不是 `String(format:)`，也不是「乘十再取整」（第 5 轮）

第 20 轮已经记过一半：JS 的 `toFixed` 平局向远离零的方向进位，C 的 `%.*f` 进到偶数。
这一轮踩到的是**修法本身的坑**：写成 `(x * 10).rounded(.toNearestOrAwayFromZero)` 依然错，
因为那次乘法自己会被舍入。`1150 / 1000` 真实值是 1.14999999999999991…，
`toFixed(1)` 读作 1.1；乘十之后**正好落在 11.5**，再向远离零进位就成了 1.2。
夹具第一次跑就把 1150 和 1450 两条抓了出来。
正确做法是从 double 自己的十进制展开取数字（`String(format: "%.30f")`），
按截断位后面第一位决定进位 —— `WebLabels.jsToFixed`。

### UI 用例里加一句 `sleep`，会让它错过要抓的瞬时状态（第 5 轮）

给头部加轮询断言时，我在「窗口画出来了」和「流推了一帧」两条断言之间插了 12 秒等待，
于是流那条直接失败 —— 夹具会**改写**那一行，它是一个要抓的状态、不是一个可以回头看的状态，
那句注释就写在断言上面。改法不是把等待缩短，是**把要对比的两次读数拆到测试的两头**：
开头记一次 `getSession #N`，翻完两页历史之后再记一次，中间一秒都不用等，
而且间隔比任何 sleep 都长。**任何 `sleep` 都不许挡在一条抓瞬时状态的断言前面。**

### 读像素要有工具，`sips --cropOffset` 不是（第 5 轮，第二次）

第 3 轮那条「截图当证据要读像素」现在有工具了：`tools/pixel-probe.sh <png> [列比例]`
打一条竖扫描，把相同颜色的段合并，同时印像素和**点**。自己找带，不用知道这台模拟器的
状态栏多高。第 5 轮拿它确认头部那一条：`y 0–108.7pt` 整段 **255**（`--background`），
`109.0–109.7pt` 是 **234** 的一条 1pt 细线，之后才是正文的 **10**。
也就是说最老一行没有透上来。
**234 而不是算出来的 229**：`Color(.displayP3, 0.8982)` 经过截图编码再读回来就是 234，
Mac 渲染的 P3 图和模拟器截下来的 sRGB 图**读数完全一致**，所以这是取色管线的常数偏移，
不是头部画错了。端点（255 / 10）永远精确，中间调不要拿算术当判据，
要拿**同一个常量在另一条渲染路径上的读数**当判据。


### 一次反证会停在第一个红的断言上，而那多半不是你想验的那条（第 4 轮 perfect-goal）

把 `SceneDelegate` 换回「列表当根」跑新写的前门用例，它确实红了 —— 红在
`openPage()` 那个辅助函数的「页面没出来」上，位置在**头条断言下游三个断言**。
原因很朴素：老形状下网页是 push 在列表上面的，从根那一屏边缘划手势什么也 pop 不掉，
于是辅助函数先失败，用例根本没走到「装着 keyring 冷启动应该看见网页」那句。

看起来还是红的，所以很容易就此收工。**但那次运行证明的是「这个用例能区分两种形状」，
不是「那条断言有牙齿」** —— 而写这条断言的全部理由，就是让将来某个人改错了以后，
失败信息里印着的是「原生列表又变成前门了」而不是「fixture 服务器是不是没起」。

改法是把头条断言挪到**只依赖 `app.launch()` 的位置**：先在空 keyring 的页面上把
keyring 存进去，然后 `terminate()` + `launch()`，紧接着就断言。中间没有辅助函数、
没有手势、没有 URL，没有任何东西能抢在它前面失败。再反证一次，红在第 473 行，
印的是那句话。

**规矩**：反证不是「看它红没红」，是**看它红在哪一行、印的是不是你写的那句**。
不是的话，先把断言挪到没有上游能挡住它的地方，再反证一次。

### 翻转的 collection view 把三样 UIKit 的东西一起弄反了（第 3 轮 perfect-goal）

第一次把时间线装进模拟器，一次跑出四个 bug，**四个在 Mac 上都看不见** ——
`tools/render-timeline.sh` 画的是一个 `VStack`，整条路上根本没有 collection view。

1. **cell 的翻转活不过一次布局。** `cell.transform` 在 `CellRegistration` 的闭包里设，
   而 `UICollectionViewLayoutAttributes` 自带一个 identity transform，`apply(_:)` 会原样赋上去。
   于是 dequeue 时设的变换在下一次布局被**无声地**抹掉，整屏会话上下镜像。
   修法：`FlippedListCell` 重写 `apply(_:)`，`super` 之后再设一遍。
   **推广**：任何在 cell 配置闭包里写 `transform` / `frame` / `center` 的代码都是同一个坑，
   属于布局的属性只能在 `apply(_:)` 里守。
2. **安全区插在反的一端。** 翻转之后 content-space 的 top 就是屏幕底部，
   UIKit 把导航栏那一百多点加在「content top」，也就是最新一条消息**下面**，
   而最老的行贴着状态栏滑过去。**把 UIKit 贡献的那份算掉**就够了
   （`adjustedContentInset = safeAreaInsets + contentInset`，所以
   `top = safe.bottom + padV - safe.top`，在手机上是个负数，合法）。
   **别用 `contentInsetAdjustmentBehavior = .never`** —— 关掉之后静止位置得自己写
   `contentOffset`，而那正好是下面第 3 条；实测那一版还会在最新一条和它上面那条之间
   多出约 97pt 的洞。
3. **在 `scrollViewDidScroll` 里同步 apply 快照会把进程弄没。**
   `loadEarlier` 一进去就 `refold()`（药丸要变 `loading…`），而 `scrollViewDidScroll`
   是 collection view 自己布局过程里的回调。`_updateVisibleCellsNow` 重入七层、UIKit 断言、
   SIGTRAP。**第一次翻页崩、上一次同样的代码没崩** —— 重入 bug 从外面看就是这样。
   改成 `DispatchQueue.main.async`，合并交给 `loadEarlier` 自己的 `loadingOlder` 闸门。
4. **iOS 26 的 scroll edge effect 被翻转带反，整屏内容读不了。**
   系统在滚动视图边缘做一层模糊加提亮、离边缘越远越淡，好让半透明导航栏后面有东西可读；
   翻转把这张遮罩里外翻了：全屏满强度，**唯独真正躲在导航栏后面那一条是清楚的**。
   `collection.topEdgeEffect.isHidden = true`（iOS 26+，要 `#available`）关掉。

**第 4 条的判据值得单独记：截图必须读像素，不能只用眼睛看。**
所有断言都过，accessibility 树完整，截图看着「有点糊」——
而实际是背景 252（该是 255）、最深的气泡 215（该是 10）。关掉之后精确回到
`WebContract.background` / `.foreground` 的数：255 和 10。
另外还猜错过一次：先按「深链接触发的 push 动画没跑完」解释，把 `SceneDelegate.open(_:)`
改成不带动画 —— 像素一点没变，改动和那段言之凿凿的注释一起回退了。

### 网页自己有两套排序，而且它们不一致（第 2 轮 perfect-goal）

`lib/chat-cache/merge-messages.ts` 的 `order` 把 ISO 解析成时刻再比；
`components/chat/use-older-pages.ts` 的 `isOlder` 直接比 ISO 字符串。
今天服务端只发三位毫秒的形状（superjson 一律 `toISOString()`），两者答案一样，
**所以这是隐患不是活 bug**。一旦出现不带毫秒的时间戳，`…:00Z` 在字节序里排在
`…:00.500Z` **后面**（`.` 0x2E < `Z` 0x5A），`isOlder` 就会认为一行不比窗口边缘旧、
于是把它丢掉而不是交给 pager —— 正是 `shedRows` 存在要防的那个洞。
**Swift 那半照抄了，两个都照抄**，并在 `merge-cases.json` 的 `orderSkew` 一节把分歧钉死：
两边都必须复现它，谁也不能「顺手把两个排序统一一下」。
移植的准绳是「和网页一致」，不是「和自己一致」；要改就改网页，那是另一轮的事。

### 「Merged, not assigned」在多一个列表之后就反过来了（第 2 轮 perfect-goal）

第 1 轮给窗口查询写的是「合并进 `inputs` 不是覆盖」，理由是屏幕上可能已经有翻页拿到的
更早的行。等历史真的搬进自己的 `older` 列表之后，这句话就成了 bug 的来源：合并会让
直播窗口跨每一次前台刷新只增不减，也会让掉出窗口的行**根本不出现在 prev/next 的差里** ——
而那个差是唯一还能把它们救进历史列表的地方。改成「查询结果就是窗口」，
掉出去的交给 `TimelinePager.shed`。**一条注释写得越有道理，越要在结构变了之后重读一遍。**

### SwiftUI 说不出「最多占父容器的 85%」，宽度只能从外面喂进去（第 20 轮）

气泡的 `max-w-[85%]` 是**列宽的一个比例**，而 SwiftUI 的 `.frame(maxWidth:)` 只吃绝对点数。
三条路都不通：`containerRelativeFrame` 把宽度**钉死**成那个值（短消息会拉成满行），
`GeometryReader` 不按内容算自己的高度（自适应高度的 cell 正好只要这一件事），
`.frame(maxWidth: .infinity)` 就是满行。所以 `TimelineRowView` 多一个 `width` 参数，
collection view 用 `bounds.width - 两侧 margin` 算给它，渲染工具用画布宽算给它。
**代价是转屏要重配一次 cell** —— 不然整段会话留在竖屏宽度上，`viewWillTransition` 里
`reconfigureItems(全部)`。

### JS 的 `toFixed(1)` 和 C 的 `%.1f` 在正好一半的地方朝相反方向进位（第 20 轮）

`fmtChars(1250)` 网页是 `1.3k`：ECMAScript 的 `toFixed` 规定「两个候选一样近就取大的」。
Swift 的 `String(format: "%.1f")` 是 C 的 printf，用的是**向偶数进位**，会给 `1.2k`。
一个思考块 1250 字符不是罕见数字，而两张截图并排看谁也发现不了差 0.1k。
写法：`(Double(n) / 100).rounded(.toNearestOrAwayFromZero)` 再自己拆整数和十分位。
**验的办法比写的办法重要**：把 `run-capsule.tsx` 里那三个函数
`sed` 出来去掉类型标注丢给 node（`sed -E 's/: (number|string|string\[\])//g'`，
它们不依赖任何 import），Swift 那边由 `tools/render-timeline.sh` 打同一张表，`diff` 两边。
30 个输入全对上才敢用 —— 这已经是「移植纯函数先跑一遍」这条第四次救场。

### 发送侧的气泡，只有时钟那一行是右对齐的（第 20 轮，截图抓到的）

`justify-end` 在**外层**：它把气泡推到右边。气泡内部是个普通块级容器，
里面的 Brain 标签、段落、文件 chip **一律从左边开始**，只有底下那行时间戳自己带
`justify-end`。我第一版把整个 `VStack` 设成 `alignment: .trailing`，
结果 BRAIN 标签和 `build.txt` 贴在气泡右边 —— 编译过、类型对、逻辑上也「说得通」，
**只有画出来才看得见**。`tools/render-timeline.sh` 从写完到发现这个问题隔了不到两分钟。

### 生成器的 oklch 正则解不了带 alpha 的声明，而 `--border` 正好带（第 20 轮）

`globals.css` 里 `.dark` 的 `--border: oklch(1 0 0 / 10%)`。`gen-ios-contract.ts` 的
`parseOklch` 是 `^oklch\(\s*L\s+C\s+H\s*\)$`，直接抛 `not an oklch() colour`。
**不要把 alpha 塞进 `parseOklch` 的返回值** —— 它的三个数是要进色彩空间换算的，alpha 不进；
而且 `ios-contract.test.ts` 里有一条 `assert.deepEqual(parseOklch(…), {l, c, h})`，
多一个字段就红。做法是先 `splitAlpha()` 切开，`ThemeSide` 带着 `alpha` 和 `declared`
（原样的声明串，只为了让生成文件的注释仍然写着 `/ 10%`），渲染时 alpha 不是 1 才补
`opacity:`。**半透明是要保留的，不能压平**：浏览器把那条发丝线合成在它背后的东西上，
压平之后除了页面自己那个底色，在别的背景上都是错的。


### 用 `parseBlocks()` 的结果去折叠，会让同一段会话两边折得不一样（第 19 轮）

上一轮在「下一项」里写着「移植时两边都应该改吃 `parseBlocks()` 的结果」。**那是错的，没做。**
`fold-runs.ts` 的 `isMachineryBlock` 只看线上那个 `type` 字符串，而 `parseBlock` 更严：
一个没有 `id` 的 `tool_use` 会掉成 `unknown`（这是**故意的**，为的是画成写着类型名的灰卡片
而不是半个工具条）。于是照那个打算做，这种块在手机上是**可见的一行**、在网页上是**折进胶囊的**
—— 同一段会话两种画法。所以 Swift 这半的分类逐字照抄网页，`FoldedMessage` 同时带着
`rawBlocks`（折叠依据的那份）和 `blocks`（`ContentBlock.parse` 之后、渲染用的那份）。
**教训**：两个函数各自都对，不代表可以把一个的输出接到另一个的输入上；接之前先找一个
两者判得不一样的输入，找不到再接。

### JS 的 `.length` 是 UTF-16 码元，Swift 的 `.count` 是字素（第 19 轮，真是个 bug）

移植 `foldRuns` 时顺手给块夹具加了 `好👍` 和 `é` 两个用例，
**第 18 轮就上线的 `ContentBlock.swift` 立刻红了**：`chars` 网页算 3 / 2，Swift 算 2 / 1。
`chars` 是折叠胶囊那句「💭 thinking · N chars」的全部内容，而摘要写进库里的那个数就是
JS `.length` 量的，所以两边必须同一把尺。改成 `body.utf16.count`。
**推广**：凡是从 JS 抄过来的「长度/偏移/截断」，默认都是 UTF-16 码元
（第 10 轮的搜索片段偏移已经踩过一次，这是第二次）。纯 ASCII 的夹具永远抓不到它 ——
夹具里必须有一个 emoji 和一个组合字符。

### worktree 里 dashboard 的 typecheck 会报一堆不是你造成的错（第 19 轮）

`prisma generate` 的产物在 `apps/dashboard/src/generated/prisma`，是 gitignore 的，
**新开的 worktree 里没有**，于是 `tsc --noEmit` 在 `session-cleanup.ts`、`unanswered.ts`、
`session-title.ts` 里吐一串 `TS7006 implicitly has an 'any' type`，看着像自己刚写的代码
把类型推崩了，其实一行都不相干。补一条软链就干净了：
`ln -sfn ~/hermit-ui/apps/dashboard/src/generated $WT/apps/dashboard/src/generated`
（和 `node_modules` 那条一样，**提交前必须删掉**，`.gitignore` 里带斜杠的目录名挡不住软链）。
判据很好认：报错的文件你这一轮根本没打开过。别去「修」它们。


### 「服务端已经有 schema」写在文件里，但没有任何人引用它（第 18 轮）

`routers/chat.ts:41` 那个 `const ContentBlock = z.union([...])` 是**死代码** ——
声明了，整个仓库零引用，所以今天**任何写入路径上都没有块级校验**。
这份进展文件自己（M4 第一条的原文）也把它当成「宽松但存在的校验」写了进来，
一路传了十七轮没人验证。真正的入口是 `/api/sync/chat-message`，它校验到
`string | unknown[]` 为止，而且注释写明了那是刻意的（块的形状是 SDK 的，会变）。
**教训**：写「今天的实现是 X」之前 grep 一次谁在用 X。一个 `const` 的存在只证明有人写过它。

### 一个不可能失败的解码器，绿灯本身不说明任何事（第 18 轮）

`ContentBlock.parse` 的设计就是「什么都能解出来」—— 于是 53 个用例第一次跑就 73/73 全绿，
这个结果和「Swift 那边其实全部返回 `.unknown`」长得一模一样。所以反证不是可选的：
往 Swift 里塞了三处偏差（interaction 缺 `kind` 时默认 permission、`is_error` 按存在与否判、
`text` 字段缺失时归 unknown），跑出来正好红在对应的三个用例上，第四条红的是同一处偏差
波及的另一个用例。**判据要落在字段上，不能只落在标签上**：驱动程序比的是整块重新编码成
网页那份 JSON 之后的结果，因为这两个实现有一半的分歧就在「哪个字段是 null、哪个字段不存在」。

### 像素比对画的是孤立的一行，看不见真列表的 cell 高度（第 18 轮）

`tools/pixel-compare.sh` 里原生那半是 `render-list.swift` 用 ImageRenderer 画的行视图，
量出来是 `RowMetrics.pitch` = 49.5pt；而模拟器上真列表的行距是 **52.33pt**
（`shots/16-session-list.png`，11 行逐点量，完全均匀不累积）。差的 2.83pt 出在
`UIHostingConfiguration` 那一层 —— `.margins(.all, 0)` 已经设过了，所以是别的东西，还没查。
**这是比对流程的结构性盲区，不是这次的 bug**：M6 那 13 屏每一屏都要过一次比对，
在那之前得知道它量不到什么。顺带：这次也是第 17 轮行高改动第一次在真机代码路径上被看过，
结论是没变形。


- **FTS5 的 `trigram` 分词器对不到三个字符的查询是静默返回 0 行**，不报错、不警告。
  中文查询两个字是常态（「义脑」就是），所以这不是边角是主路。判据必须写在调用方
  （`ChatCache.canUseIndex` 一票否决 + fixture 里一条专门断言它对「义脑」返回 false），
  不能指望 SQLite 提醒你。**另一半同样重要：`unicode61`（默认分词器）对中文查询
  一行都不返回** —— 它把整句汉字当一个词。这两件事都是跑出来的不是查出来的，
  `tools/cache-fixture.sh` 每次都会把三列数字打出来。
- **`INSERT OR REPLACE` 会让 external-content 的 FTS5 索引悄悄长脏，而搜索看不出来。**
  REPLACE 是靠**删掉**冲突行来满足约束的，而删除触发器只在 `recursive_triggers` 打开时
  才触发（默认是关的），于是旧行的 trigram 留在索引里，新行还换了一个 rowid。
  但是 `search` 是 `prose_fts JOIN prose ON rowid` 的，孤儿条目连不上表、直接被丢掉 ——
  **查询结果一直是对的，唯一的症状是文件永远变大**。所以写入用 upsert
  （`ON CONFLICT(id) DO UPDATE`），并且验收要用 FTS5 自己的完整性检查。
- **`integrity-check` 不带参数（或带 0）只检查索引和它自己一致，检查不出上面那种孤儿。**
  要跟内容表对账必须写 `INSERT INTO t(t, rank) VALUES('integrity-check', 1)`。
  第一版反证 `INSERT OR REPLACE` 时 502 条检查**全绿**，就是因为参数没给 1；
  给了 1 之后，同一处改动准确地只红了那一条。（SQLite 3.42+，iOS 17 是 3.43。）
- **一条断言反证不出来，不代表它没用，但要写下来它反证不出来。** 这一轮四个反证里，
  「`planSync` 的稳定排序」那条**没有变红** —— Swift 的 `sorted(by:)` 文档上说不保证稳定，
  但今天的实现（timsort）实际就是稳定的，所以把显式的次序兜底删掉，26 个等值 watermark
  的用例照样全过。兜底留着（文档承诺才是契约，实现不是），但**这张表证明不了它在起作用**，
  下一个人不要以为它证明了。另外三条反证是有效的：片段窗口差 1、分词器换回 `unicode61`、
  上面那条 REPLACE，各自只红了预期的那几条。
- **Foundation 的 `AsyncLineSequence`（`bytes.lines`）会把空行整个吞掉，而 SSE 的空行
  就是帧分隔符。** `"a\n\nb\n"` 出来是 `["a", "b"]`，没有开关能关掉；纯内存的字节序列
  也一样，所以不是 `URLSession` 的问题。后果极其安静：连接建立、字段一行行读进来、
  **一个帧都不投递**，然后报告干净地读到了流末尾。不抛异常、不打日志、
  `swiftc -typecheck` 当然更看不出来 —— 第一版 `HermitStream` 就是这样，
  `tools/stream-fixture.sh` 头一次跑就抓到了（12 个事件期望，实到 0 个）。
  改成自己按字节切行（`0x0A` / `0x0D` / CRLF），代价是每字节一次 `await`，
  而 `.lines` 内部本来就是这么干的，所以没有更便宜的写法 —— 真嫌慢就得上
  `URLSessionDataDelegate` 收整块。**推广一下：Foundation 里名字像"按行切"的东西，
  先拿 `a\n\nb` 试一遍再用。**
- **`HermitAPI` 那个 `URLSession` 绝对不能拿来跑流。** 它设了
  `timeoutIntervalForResource = 30`，那是**整条连接的寿命上限**，不是空闲超时 ——
  SSE 挂上去会每次都在第 30 秒被掐断，症状是「每次重连后时间线更新半分钟然后安静」，
  看起来像服务端的锅。`HermitStreamSession.shared` 是另一份配置：资源超时一周，
  空闲超时按每个请求的 `idleDeadline` 设。
- **泛型类里不能有 static 存储属性**（`static stored properties not supported in
  generic types`）。`HermitStream<Row>` 想挂一个共享 `URLSession` 就得把它放到外面
  一个非泛型的 `enum` 里。
- **`Task { await self.run() }` 会让 `deinit` 永远不触发。** 实例方法在任务里跑着，
  任务就持有 `self`，于是「对象被释放时取消连接」这条永远不会发生，流会活过它的持有者。
  `HermitStream` 的重连循环因此是 `static func run(_ cfg: Config, _ emit:)`，
  把要用的东西全打包成一个值传进去，`self` 一点都不碰。

- **模拟器上 keychain 的每一次调用都回 `-34018`，因为测试脚本是 `CODE_SIGNING_ALLOWED=NO`
  构建的。** 没签名的包不带任何 entitlement，也就没有 keychain access group，
  `SecItemAdd` / `SecItemDelete` 一律 `errSecMissingEntitlement`。真机上没这个问题
  （正常签名自带 `application-identifier`），**只有测试路径是坏的**，而且坏得很像
  「keychain 代码写错了」。改法是 ad-hoc 签名而不是不签名：
  `CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual PROVISIONING_PROFILE_SPECIFIER= DEVELOPMENT_TEAM=`
  —— `-` 不需要 team、不需要描述文件，`tools/bridge-fixture.sh` 和 `smoke.sh` 都换过来了。
  一并得到的教训：**`SecItem*` 的 OSStatus 不要在内部吞掉转成 Bool**。第一版
  `Keychain.write` 返回 `Bool`，页面上只看到 `RESULT keychain.clear fail`，
  什么都推断不出来；把数字带到错误文案里（`the keychain refused the delete (-34018)`）
  之后，一张截图就定位了。这个设计留下了，不是临时调试代码。
- **Keychain 是异步的，`getActiveKey()` 是每个请求都调的同步函数** —— 所以接缝不能是
  「`read()` 里直接读 keychain」。做法是整份 keyring 在文档存活期内放内存
  （`keyring.ts` 的 `secure`），启动时 `hydrateKeyring()` 一次性灌进去，写入时内存先改、
  Keychain 在后面追。`auth-gate.tsx` 在 `hydrated` 之前只画骨架，所以没有「组件已经在查
  但 key 还没到」的窗口。另外 `keyring.ts` 只能**动态 import** `native-bridge.ts`
  （后者静态 import 前者，静态成环会让其中一个在求值时是半空的），而动态 import 又不能
  出现在写入路径上：登录成功后紧接着 `window.location.href = '/chat'`，
  等一次 chunk 加载就赶不上文档销毁、key 就没写进去。解法是 hydrate 时把模块暖上，
  写入路径只排一个微任务。

- **`-hermitOrigin` 会盖住 `setOrigin` 刚写进去的值，所以「切服务器」这件事一次启动里
  看不出来。** 优先级是 launch argument > 用户设的 > 默认，而 UserDefaults 的
  **argument 域本来就压在 standard 域上面** —— 于是「用 `-hermitOrigin` 把 App 指到测试
  页面 → 页面调 `setOrigin` → 确认」跑完，`AppConfig.origin` 一个字没变，
  `switchOrigin()` 重新加载的还是那张测试页。这不是 bug，是第 1 轮定的优先级在起作用。
  UI 用例得**分两次启动**：第一次带 `-hermitOrigin` 把页面喂进来并确认，
  第二次 `launchArguments = []`，这时候屏幕上出现什么，完全由第一次落盘的值决定 ——
  顺带把「真的持久化了」也一起验了。用例结尾必须点 "Use default" 收拾干净，
  否则这次安装会一直指着一个死端口，`smoke.sh` 后面的用例全跟着遭殃
  （XCTest 按方法名字母序跑，`testThePageCanProposeAnotherServer` 排最后，
  这一层保险不要依赖）。
- **`curl -fsS` 放在「等服务起来」的重试循环里，会把每次预期内的失败都打到 stderr。**
  循环里用 `-fs`，最后那次确认才用 `-fsS`。看起来像跑挂了其实没有，浪费的是读日志的人。

- **Fetch 的 bad ports 名单不能凭记忆写，它长得不像个规律。** 这个文件上一版把它记成
  「101–115」「137–139」「512–515」「6665–6669」那样的连续区间 —— **错的**：
  真名单里 105、106、107、108、112、114、138 都**不在**，而 104 和 109 在；
  另外 4190、6679 上一版整个漏了。照着区间抄会把用户自己机器上的合法端口封掉。
  正确做法是从一个活的实现里读出来：`fetch('http://127.0.0.1:<p>/')` 跑 1–11000，
  留下报 `bad port` 的（Node 26 的 undici 实现的就是这条规范），耗时 0.7 秒，
  结果 82 个数字。跟第 1 轮那条教训是同一件事 —— 移植常量和移植函数一样，先跑再写。
- **`pnpm --filter @hermit-ui/dashboard typecheck` 在这台机器上从来就过不了，
  跟你改没改它无关。** 两层原因：worktree 里根本没有 `node_modules`（pnpm 装在
  `~/hermit-ui`，而且是 hoisted，`apps/dashboard/node_modules` 不存在）；
  就算链过去，Prisma 客户端没生成，`tsc` 会报 **261 个** `implicitly has an 'any' type`。
  能用的配方（第 3 轮验证过，跑完是 0 个错）：
  `ln -sfn ~/hermit-ui/node_modules $WT/node_modules`，然后在 `$WT/apps/dashboard` 里
  `DATABASE_URL="postgresql://x:x@127.0.0.1:5432/x" $WT/node_modules/.bin/prisma generate`
  （只生成类型，不连库，77 毫秒），最后 `$WT/node_modules/.bin/tsc --noEmit`。
  **别拿 261 个错当「我改坏了」**，也别拿它当「反正本来就红」—— 先生成再看。
- **`normalizeOrigin` 和 `normalizeBase` 已知有两处不一致，都是有意的**，M2 写防漂移
  断言时别把它们当 bug：`""` 网页返回 `''`（意思是「本站」），Swift 报
  `backend address is empty`（壳没有「本站」）；`https://x:0` 网页放行、Swift 报
  `backend address is not a URL`（Swift 多一句 `1...65535`）。除这两条外，
  第 3 轮拿 25 组输入两边逐条比过，完全一致。

- **`normalizeBase` 不能整份套到 `-hermitOrigin` 那个键上。** 它要求裸 origin、
  非 localhost 必须 https，而 `SmokeTests.launch(path:)` 恰恰往后面接路由
  （`http://localhost:4102/push`），README 又把「http 连 LAN 上的笔记本」写成正规用法。
  两条都会被挡掉，而且挡掉的表现是**静默回落到生产地址**——smoke 跑得下去，只是全跑错了
  服务器。所以拆成两个键，严格校验只作用在用户输入上。
- **移植纯函数，先拿同一组输入把两边跑一遍，再写断言。** 我按想当然写了
  「`ftp://x` 应该报 must be http(s)」，跑出来是「must be a bare origin, no path」——
  因为不以 `http(s)://` 开头的串会**先**被拼上 `https://`，于是 `ftp://x` 解析成
  host=`ftp` + path=`//x`。`normalizeBase` 里那句 `must be http(s)` 从字符串入口根本
  走不到。把真的 `normalizeBase` 抠出来在 node 里跑了同一组 11 个输入，Swift 和 JS 逐条
  一致，才敢写死断言。
- **`swiftc -typecheck Hermit/*.swift Shared/*.swift` 编不到 `HermitTests/`。**
  只跑它，改坏的单测一声不吭。真跑单测的命令见上面「一轮怎么做」第 3 条。
- **别拿低号端口当「连不上的地址」——WebKit 的封禁端口不会产生导航失败。**
  第 2 轮我用 `http://127.0.0.1:9` 想逼出离线屏，屏幕白了一片，
  `didFailProvisionalNavigation` 一次没响。WebKit 对 Fetch 规范里的 bad ports
  （9 是 discard）是拒绝加载并**提交一个空文档**，日志里看到的是
  `didCommitLoadForFrame` + `didFinishLoadForFrame`，24 毫秒。换成 `49517` 立刻正常：
  8 秒内出离线屏。**排查花了半小时，因为「白屏」和「延迟很久的白屏」长得一模一样**——
  同一轮里 `https://no-such-host.invalid` 也白屏，但那个是真失败，只是 WebKit
  等了 **37 秒**才报 `NSURLErrorDomain -1200`。所以看到白屏先看时间：秒级 = 被封端口，
  半分钟以上 = 真在等超时。
- **模拟器上 `simctl openurl` 弹的「在 "Hermit" 中打开?」是 SpringBoard 级的模态，
  会一直挂在那儿挡住后面所有事。** 它熬过了 `simctl uninstall` + `install`，
  导致后一次 UI 测试 43 秒全程什么都点不到、报的却是「找不到按钮」。
  没有 `simctl` 命令能点掉它（`simctl` 没有 tap），XCUITest 可以，
  但触发 openurl 的又只能是宿主机 —— 两边碰不到一起。
  **判据：UI 测试莫名找不到自己的控件，先 `simctl io screenshot` 看一眼整屏。**
  清掉的办法是 `simctl shutdown` + `simctl erase`。
- **`defaults write <容器路径>/Library/Preferences/<bundleid>.plist` 种不进模拟器 App 的
  UserDefaults。** 宿主机的 `cfprefsd` 和模拟器里的不是同一个，写完读得回来，App 起来照样
  拿默认值。要伪造一个「用户设过的地址」，用**启动参数**：`-hermitOriginOverride <url>`
  —— UserDefaults 的 argument 域优先级最高，`AppConfig.userOrigin` 直接就读到了，
  而且**不落盘**，不会污染同一次安装里跑的其他测试。
- **本机的模拟器是中文的**（系统弹窗是「取消 / 打开」）。所以 XCUITest 里别去找系统控件的
  英文标签；自己代码里写死的英文标题（`Connect` / `Cancel` / `OK` / `Use default`）不受影响，
  但 `clearButtonMode` 给的清除按钮是系统的，要清输入框请发退格
  （`XCUIKeyboardKey.delete.rawValue` 重复 N 次），别按标签找。

- **这台 Mac 上没有 Postgres，也没有 Docker** —— 没有 `psql`/`pg_isready`/`initdb`，
  5432 端口没人监听，`secret list` 里也没有这个库的 `DATABASE_URL`。所以**改服务端
  数据库逻辑这件事，在本机拿不到「真的跑一遍」这个档位**，验证的天花板是三条：
  `prisma generate` 后 `tsc --noEmit` 0 错（这一步顺带证明了 `sessionId_clientId`
  这个复合键真的存在）；`prisma migrate diff --from-empty --to-schema-datamodel
  prisma/schema.prisma --script`（**不连库**）打出 Prisma 自己会生成的 SQL，
  拿来跟手写的迁移逐字比对；然后就只能读代码了。**别把「typecheck 过了」写成
  「幂等键验证过了」**，报告里要分开说。
- **`.gitignore` 里的 `node_modules/` 挡不住 `node_modules` 这个软链。** 上面那条
  typecheck 配方要 `ln -sfn ~/hermit-ui/node_modules $WT/node_modules`，而带斜杠的
  ignore 规则只匹配目录，软链在 git 眼里不是目录 —— 于是它以 `??` 出现在
  `git status` 里，一个 `git add -A` 就把一条指向 worktree 外面的软链提交进仓库。
  跑完 typecheck 顺手 `rm -f $WT/node_modules`，别依赖 ignore。
- **幂等键留了一个窄窗口，是知情选择，不是漏掉的。** `chat.send` 里 INSERT 和后面那次
  `chatSession.update`（`lastMessageAt`、清 `cancelRequestedAt`、`preview`）不在同一个
  事务里。原请求如果正好在两者之间被进程重启打断，重试会命中幂等键、整段提前返回，
  于是那次 update 永远不会发生 —— 最难受的是 `cancelRequestedAt` 没被清掉，
  gateway 会当场把新一轮杀掉。修法是把两次写包进 `prisma.$transaction`，
  但那是全 App 最热的写路径，而本机没有数据库可以验证，所以没动。
  真要修，等有库能跑的时候连着一起验。
- **`wt.sh check` 在 cron 会话里会回 `sole-session`，而那是错的。** 已知的坑是
  「`enter` 会 die、`check` 反而正常」—— 第 7 轮发现 `check` 也是坏的，而且坏得更危险：
  没有 `HERMIT_SESSION_ID` 时它不报错，直接输出
  `isolated=no reason=sole-session`，也就是在**建议你直接在共享检出里动手**，
  哪怕 SessionStart 的提示明明列了 8 个兄弟会话。补上
  `HERMIT_WT_SELF` 之后同一条命令立刻变成 `isolated=needed siblings=8`。
  所以 cron 会话里那行 export 不是给 `enter` 用的，是**在 `check` 之前**就要设：
  `export HERMIT_WT_SELF="hermit-$(printf '%s' "$CLAUDE_CODE_SESSION_ID" | sed 's/[^a-zA-Z0-9_-]/_/g' | awk '{n=length($0); print substr($0, n>12 ? n-11 : 1)}')"`
- **Swift 的 `JSONEncoder` 把字符串里的 `/` 写成 `\/`，`JSON.stringify` 不会。**
  于是 `chat.listSessions` 的 GET 里，输入 `a/b` 出去是 `%22a%5C%2Fb%22`，
  网页端同一个输入是 `%22a%2Fb%22`。**这不是 bug**：`\/` 是合法的 JSON 转义，
  `JSON.parse` 还原成同一个字符串，而且没有任何东西对这个 URL 签名或缓存。
  写在这里是因为它看起来太像一个编码 bug —— 第 7 轮为此专门比对了
  `HermitAPI.percentEncoded` 和 `encodeURIComponent` 四组输入，**逐字节相同**，
  差异全部来自 JSONEncoder 那一层。
- **`swiftc` 报 `ambiguous use of 'init(name:priority:operation:)'`（指着 `Task {`）
  或者 `failed to produce diagnostic for expression`，说的都不是 `Task`。** 那是类型检查器
  在闭包里某处放弃了，然后把错报在最外层。第 7 轮的真凶是
  `optional.map(String.init)` —— `String.init` 有几十个重载。改成 `.map { "\($0)" }`
  就好了。诀窍是别去改它指着的那一行，去找闭包里最"聪明"的那个表达式。
- **`set -e` 在 EXIT trap 里同样生效，所以 `wait` 一个刚被 `kill` 掉的后台任务
  会让整个脚本以 143 退出。** `api-fixture.sh` 收尾要 `wait` 才能不打印
  `Terminated: 15`，但不加 `|| true` 的话，一次完全成功的运行会报失败 ——
  下一轮的 cron 看到非零退出码就会以为验证没过。

---

- **`tools/render-cards.sh` 自己有一份 swiftc 文件清单，`Shared/` 加文件要手动同步它。**
  它把 `Shared/SessionCard.swift Shared/StatusPalette.swift LiveActivity/SessionCardViews.swift`
  单独编成一个 macOS 程序，所以 `StatusPalette` 一旦引用新的 `Shared/WebContract.swift`，
  这个脚本就编不过 —— 而 `swiftc -typecheck Hermit/*.swift Shared/*.swift` **照样是绿的**，
  因为它压根没编 `tools/`，也没编 `LiveActivity/`。反过来说：
  **`render-cards.sh` 是目前唯一覆盖 widget target 那几个 SwiftUI 文件的命令**，
  改了 `Shared/` 就顺手跑一次，5 秒。
- **`swiftc -typecheck` 没有输出、退出 0，先确认它真的在干活。** 17 个文件 2 秒跑完是正常的，
  但「没输出」和「没编到」长得一模一样。往 `Shared/` 扔一个
  `let x: Int = "nope"` 的临时文件跑一遍（应当 exit 1、两条 error），再删掉 —— 这一轮做过，
  是真的在检查。
- **一条从没红过的防漂移断言等于没有。** 写完 `ios-contract.test.ts` 之后，
  把 `WORKING_STALE_MS` 改成 10 分钟跑一次（应当只有「生成物过期」那条红）、
  把 `ctx-bar.tsx` 的 70% 档改成 `bg-sky-400` 再跑一次（应当只有「分档映射」那条红），
  然后恢复、确认全绿。两次都命中了**预期的那一条**，这才算断言是活的。
- **判断「颜色改了没有」，PNG 逐字节比对不够用。** 生成的调色板和手写的差在小数第四位，
  五张卡片**每一张的字节都不同**，但真去比像素是「最多 0.12% 的像素差 1/255」。
  没有 ImageMagick 也没有 PIL 的机器上（这台就是），25 行 Swift 就够：
  `NSImage(contentsOfFile:)` → `cgImage(forProposedRect:)` → 画进
  `CGContext(bitsPerComponent: 8, premultipliedLast)` → 逐通道取 max。
- **`tailwindcss/colors` 能直接给出 oklch 字符串，但它的 `exports` 里没有 `types` 条件。**
  `dist/colors.d.mts` 文件是在的，`tsc` 靠邻居推断多半也能过，但那是赌运气。
  `theme.css` **在** exports 里（`"./theme.css": "./theme.css"`），
  `createRequire(import.meta.url).resolve('tailwindcss/theme.css')` 拿到路径自己
  正则抓 `--color-<族>-<档>: oklch(...)`，零类型风险，而且那才是 `@import "tailwindcss"`
  真正喂给浏览器的东西。
- **`chat/page.tsx` 和 `push/live-activity.ts` 的常量只能按文本读，不能 import。**
  前者的 `IDLE_DEAD_MS`/`BACKOFFS` 是组件内部的局部量，后者一 import 就把 Prisma
  拉起来（`@/server/db`），在 `node --test` 里等于要数据库。所以生成器对这两个文件
  走正则 + 一个只认数字和 `+-*/()_` 的表达式求值器，并且**要求声明恰好命中一次**
  —— 改名会炸，但炸在测试里，这正是要的。剩下的 `chat-window.ts` 是叶子模块，直接 import。

- **移植一个「返回样式」的函数时，把样式留成原文的字符串，别在移植途中就解成颜色。**
  `sessionStatusView` 返回的是 `bg-amber-400/50` 这种 Tailwind 类名。Swift 侧照样
  返回字符串，对照表就能**逐字节**比网页的答案；一旦在移植里直接返回 `Color`，
  能比的就只剩「颜色对不对」，而 `/50` 这半个信息——它是「在跑但没动」和「在跑」的
  唯一区别——会在比对里彻底看不见。类名转颜色单独放一处（`StatusPalette.dot`），
  再单独给它一条「网页能发的每个类名这边都认得」的断言。
- **JS 的 `${数字}` 和 Swift 的 `"\(数字)"` 不一样，而且正好落在会上屏的地方。**
  `shortDuration` 收的是原始 JS number，`elapsedSec: 12` 在浏览器里打成 `12s`，
  Swift 的 `"\(12.0)"` 打成 `12.0s`。同一族的坑还有两个，都是 JS 的 falsy：
  `a.label || 'tool'` 对**空字符串**也回退，`attempt && maxRetries` 把 0 当没有。
  三条我都是从对照表里看出来的，不是读代码读出来的——反证 1（把 `jsNumber` 关掉）
  一次红了 12 条时长用例。
- **`swiftc -typecheck` 编不到 `tools/`，`tools/*.sh` 编不到 UIKit。** 两边的覆盖面
  是错开的：这一轮 `Hermit/SessionStatus.swift` 同时被 `swiftc -typecheck`（iOS SDK）
  和 `tools/status-fixture.sh`（macOS，只连 `StatusPalette` + `WebContract`）编，
  所以它**不能 import UIKit**。反过来，`SceneDelegate` 那种只有 UIKit 的改动，
  两个脚本都证明不了任何运行时行为，只有模拟器能——`tools/bridge-fixture.sh` 约 50 秒
  （含全量构建），跑完自己 `shutdown` + `erase`。
- **`URL(fileURLToPath:)` 是 Node 的写法，Swift 是 `URL(fileURLWithPath:)`。**
  写夹具驱动脚本时手指比脑子快，编译器的报错还挺长。

### 网页的行高来自 Tailwind preflight，不在这一行的任何 class 里（第 17 轮）

`session-row.tsx` 通篇没有一个 `leading-*`，所以「`text-[13px]` 那行有多高」这个问题，
答案不在这一行、也不在这个文件里：Tailwind preflight 往 `<html>` 上写了
`line-height: 1.5`，于是 13px 的标题画进 19.5pt 的行盒、10px 的副标题画进 15pt 的，
一行连着 padding 是 `6 + 19.5 + 2 + 15 + 6 = 48.5`。SwiftUI 自己算是 15.5 和 12.6，
行高 43 —— 第一行几乎重合，到第十一行整整错开一行。
`.frame(height:)` 把文字在行盒里居中，和 CSS 的 half-leading 是同一件事，基线也就对上了。
**判据不是读 class，是问浏览器**：`HERMIT_MEASURE=1 tools/render-web-list.sh` 会把
`#frame` 底下每个元素的 `getBoundingClientRect()` 打出来。M6 每一屏都从这一步开始，
自己推 CSS 的行高等于拿一份猜测去比另一份移植。

### ImageRenderer 会把脉动的点定格在它最暗的那一帧（第 17 轮）

`animate-pulse` 那个点在 `render-list.sh` 里画出来是**半透明**的：`onAppear` 把 `dim`
置真，ImageRenderer 拿到的是动画的终态，于是四个会脉动的点全部只有 50% 强度 ——
比对报四个点不一致，而屏幕上什么毛病都没有。网页那半早就用一条
`.animate-pulse { animation: none !important; }` 掐掉了动画，原生这半漏了同一件事。
**顺带一个坑**：`accessibilityReduceMotion` 在 environment 里是只读的，
`.environment(\.accessibilityReduceMotion, true)` 直接编译不过
（`cannot convert KeyPath to WritableKeyPath`），所以另开了一个
`\.hermitStillFrame`；产品里 `StatusDot` 同时认这两个。
改完四个满色的点逐字节相同（amber 400 = (255,185,0)、sky 400、rose 500、emerald 500）。

### SwiftUI 的 monospaced 系统字体比浏览器的等宽字体宽 3%（第 17 轮）

副标题那行「sway · background · 1h 28m」原生比网页宽 4.3pt，一开始以为是 SF 的自动字距，
`.tracking(0)` 加上去**一个像素都没变**（69428 → 69428，完全相同）。真正的原因量出来是字面
的：`NSFont.monospacedSystemFont(ofSize: 10)` 是 `.AppleSystemUIFontMonospaced-Regular`，
`m` 的步进 **6.1816**；浏览器拿到的是 SF Mono，步进 6.0。22 个字乘 0.18 就是那 4pt。
**这不是能改的数字**，除非往包里塞一份字体。顺带查到的事实：dashboard 的
`--font-mono: var(--font-geist-mono)` 其实**从来没有定义过**（`layout.tsx` 只加载了
Geist sans），所以真机上那一列用的是 WKWebView 的默认等宽字体。要不要为这 3% 打包一份
字体，是 sway 的决定，不是这一轮能定的。

### 两个实现判得不一样，第一个抓到的却是夹具少喂了一个输入（第 16 轮）

像素比对第一次跑出来，「网关沉默了」那行原生是灰点 `stale`、网页是黄点 `working`。
读代码怎么读都对得上，因为差的不在代码里：`sessionStatusView` 判 stale 需要
「我们一直联系得上」这个前提（`lib/dashboard-reach.ts`），而**一个刚起的 Node 进程从没收到过
任何回答**，`dashboardReach()` 回 `{observedAt: 0, reachableSince: 0}`＝「没有依据」，
于是它不判 stale；Swift 的 `StatusOptions.observedAt` 默认 `nil`＝退回 now＝联系正常。
两边都没错，是测试台只喂了 11 行数据、没喂第 12 个输入。修法是渲染前先补一小时的正常联系
（`for (let t = NOW - 3_600_000; t <= NOW; t += CONTACT_GAP_MS / 3) noteDashboardAnswer(t)`
—— 必须是**一串**间隔小于 `CONTACT_GAP_MS` 的回答，只调一次会把 `reachableSince` 钉在 now，
staleness 的时钟从那一刻起算，照样不 stale）。
**推广**：两个实现对不上时，先数一遍两边各自吃了几个输入，再去读代码。

### `NSBitmapImageRep.setColor(_:atX:y:)` 会写出一张纯白的图，而且不报错（第 16 轮）

`png-diff` 第一版用 `setColor` 往一张 `.deviceRGB` 的 rep 上画热力图：统计数字全对
（10.05% 不一致），**写出来的 PNG 是一整张白**。唯一的线索是 stderr 里每个像素一行的
`Unrecognized colorspace number -1` —— 看起来像噪音，实际是「这次写入没落下去」。
改成直接写 `out.bitmapData` 的字节（`y * bytesPerRow + x * 4`），既正确又快两个数量级。
**顺带一条判据**：一个只输出统计数字的比较工具，你没法知道它画的图对不对 ——
所以热力图必须自己看一眼，看到的是「第一行重合、之后逐行错开」才算这工具能用。

### Chrome `--headless=new --screenshot` 写完图之后不会退出（第 16 轮）

截图文件老老实实写出来了，进程就是不结束，直接把脚本挂死（这一轮吃了一次 120 秒超时）。
`--headless=old` 在新版 Chrome 里已经没了，所以只能自己收尾：后台起 Chrome，
轮询截图文件出现且大小稳定，然后 `kill` 掉自己那个 pid。
**不用担心撞到 agent 自己那个 Chrome**：它带独立的 `--user-data-dir`，而 gateway 的
chrome-reaper 只看 `<agent>/browser/chrome.json` 里记着的 pid。

### `tsx` 把 dashboard 的脚本编成 CJS：没有顶层 await，也没有 `import.meta.url`（第 16 轮）

`apps/dashboard` 没有 `"type": "module"`，所以 `tsx scripts/x.tsx` 走 CJS 输出：
顶层 `await` 直接报 `Top-level await is currently not supported with the "cjs" output format`，
`import.meta.url` 也不成立。把异步部分包进 `main().catch()`，路径用 `__dirname`。
另外 JSX 走的是经典 transform，**每个 .tsx 都要显式 `import React from 'react'`**，
否则运行时报 `ReferenceError: React is not defined`（`tsc --noEmit` 是绿的，因为
Next 那边配的是 automatic runtime —— 又一个「类型检查看不见」的坑）。

### worktree 里跑任何 node 脚本，都要先补那条 node_modules 软链（第 16 轮，第二次）

已知的 typecheck 配方（`ln -sfn ~/hermit-ui/node_modules $WT/node_modules`）对
`tsx`、`postcss`、`@tailwindcss/postcss` 一样适用，而且**脚本本身必须待在仓库里**才解析得到
—— 把探针写到 `/tmp` 再跑，报的是 `MODULE_NOT_FOUND`，看着像依赖没装。
`render-web-list.sh` 因此自己找 `node_modules`（先仓库根，再 `~/hermit-ui`）。
跑完记得 `rm -f $WT/node_modules`，`.gitignore` 里带斜杠的 `node_modules/` 挡不住一条软链。

### 网页从栈里 pop 掉，就等于被销毁了（第 15 轮）

`UINavigationController` 是栈里那些 view controller 的**唯一持有者**。列表当了根之后，
每一次「从网页返回列表」都是把 `WebViewController` pop 出栈 —— 于是 WKWebView、已经加载好的
文档、滚动位置、所有开着的连接一起释放，下一次点行又要把整个 dashboard 重新载一遍，
而那正好是做前门要消掉的那次等待。**症状不会是崩溃或报错，只是"每次进会话都白屏两秒"**。
所以网页那一份实例由 `SceneDelegate` 用 `private lazy var web` 强持有，栈只是借去显示。
（这条是写的时候想到的，不是跑出来的 —— 假页面很轻，重载快到看不出来。）

### 导航栏一隐藏，UIKit 就把自己的返回手势关掉了（第 15 轮）

网页那一屏的导航栏是隐藏的（页面自己画头部），于是那一屏**既没有返回键、也没有返回手势**,
前门变成一扇单向门。打开的办法是给 `nav.interactivePopGestureRecognizer` 装一个 delegate,
`gestureRecognizerShouldBegin` 里判 `viewControllers.count > 1`（在根上放行会让栈卡在
一次没有目的地的转场里）。副作用是左边缘被壳拿走了，手机上网页用它拉侧栏抽屉 ——
判断和开关都写在 `SceneDelegate` 的注释里，见「下一项」里要 sway 拍板的那条。

### 冷启动画出来的快照，每一行都写着 `stale`（第 15 轮，不是 bug）

`sessionStatusView` 判 `snapshotAt`，阈值 45 秒；而快照里的 `snapshotAt` **按定义就是旧的**。
所以冷启动第一帧是一屏灰点加一排 `stale`，等真正的响应落地才恢复颜色 ——
`shots/20`（拉取被 401 挡住，一直是灰的）和 `shots/21`（拉取成功）并排看最清楚。
网页的 `placeholderData` 有完全一样的性质，只是它通常只持续一个来回。**移植是忠实的,
没有偷偷把快照里的时间戳往前挪** —— 那才会变成一屏说谎的绿点。

### 要证明「第一帧是快照画的」，就得让那次拉取失败（第 15 轮）

对着一个答得出东西的服务端，有没有快照都是「出现了一列行」，只差几百毫秒，截图和断言都分不出。
所以假页面加了一个按钮：**同样两条 keyring，条目 id 不变，token 换成服务端不认的** ——
快照是按条目 id 存的，所以照样找得到，而它背后那次请求只会 401。于是「有行 + 没有错误文案」
就是一句只有快照能满足的断言。没有快照的同一次启动，屏幕上只有
`Could not load the session list.`（反证跑过，正好卡在这里）。

### 一整套 UI 用例写死了「网页是根」，换根之后五条一起垮（第 15 轮）

五个用例每一条开头都是 `app.webViews.buttons[…].waitForExistence`，也就是默认启动之后
网页就在眼前；换根之后这个前提对一半、错一半（取决于上一条用例有没有留下 keyring）。
修法不是逐条打补丁，而是把「我要哪一屏」变成助手函数：`openPage()`（在列表上就点 ＋）、
`backToSessionList()`（在网页上就边缘右滑），用例从此描述意图而不是描述栈的形状。
**顺带一提这也是覆盖率**：`backToSessionList()` 每调用一次就真的做一次边缘返回手势。

### diffable 的标识符用行值，开始轮询之后整个列表每 5 秒闪一次（第 14 轮）

`UICollectionViewDiffableDataSource<Section, SessionListItem>` 看着很自然，因为
`SessionListItem` 是 `Hashable`。但它是**对所有字段**合成的 `Hashable`，而
`snapshotAt` 这种字段每次 poll 都在动 —— 于是「同一条会话、晚一秒」在快照里是一条
全新的行：旧的删、新的插，整屏每 5 秒重来一遍。**只手动刷新的时候完全看不出来**，
第 12、13 两轮就是这么过去的。标识符要用 `String`（会话 id），行数据放一张
`[String: SessionListItem]`，内容变了的行走 `snapshot.reconfigureItems`。
配套的坑：`reconfigureItems` 只能点名**已经在数据源里**的行，新插入的行不能进那个数组，
所以过滤条件是「上一份里有，且和这一份不一样」。

### 一个不会自己变的假服务端，证明不了任何「自动」的行为（第 14 轮）

轮询这件事在截图里是隐形的：轮询的列表和开屏之后就冻住的列表画出来一模一样。
所以 `tools/bridge-fixture/server.py` 加了一个进程内计数器，把「这是第几次回答」
写进最后一行的标题（`poll #6`），UI 用例就能读那个数字：先读一次，什么都不碰，
断言 `+2` 出现 —— 那只能是定时器。**离开屏幕要停**同样能测：退回网页等 12 秒再进来，
计数只许涨 1（允许 2，一个已经在路上的请求照样会到服务端）；如果定时器还在后台跑，
12 秒是两三次。反证做过：把 `startPolling` 改成直接 return，用例正好卡在
「the list never refetched by itself」那一条。

### 浅色模式下，网页自己的骨架屏几乎是看不见的（第 14 轮，请 sway 拍板）

`--sidebar` 是 `oklch(0.985)`、`--sidebar-accent` 是 `oklch(0.97)`，差 1.5%，
再乘 `/40` 的透明度，浅色下六条骨架和背景几乎同色（`shots/session-list-loading-light.png`
就是这样，深色那张很清楚）。**这不是移植错了，网页就长这样** ——
所以按「静态呈现和网页一致」这条目标，我没有偷偷调深它。
真要改，那是**网页和 iOS 一起改**的事，不是在 Swift 里挑一个更好看的灰。

### `wt.sh land` 会把 worktree 里的截图一起删掉（第 13 轮，真踩到了）

`land` 最后一步是 `git worktree remove`，它删的是整个目录 —— 包括 `apps/ios/shots/`，
而那个目录是 gitignore 的，**所以三张刚看过的截图在 land 的那一刻就没了**。
只有提交进去的东西能活下来。两个办法，选一个：
跑测试时把 `HERMIT_SHOT_DIR` 指到**主检出**（`HERMIT_SHOT_DIR=~/hermit-ui/apps/ios/shots`），
或者 land 之前先拷出来。这一轮是从 xcresult 里捞回来的，能捞是因为
`HERMIT_DERIVED_DATA` 设过、脚本没删它：
`xcrun xcresulttool export attachments --path <…>.xcresult --output-path <dir>`，
文件名在同目录的 `manifest.json` 里（导出的是 UUID 名，要照 manifest 改回来）。

### 假数据要按请求现算，不能写死时间戳（第 13 轮）

`snapshotStaleMs` 是 **45 秒**（不是 45 分钟）。所以一份时间戳写死的会话夹具，
写完一分钟之后每一行都会判成 `stale`——灰点、灰字，看起来像移植错了判定阶梯，
其实是夹具过期了。`tools/bridge-fixture/server.py` 因此在**每个请求里**用
`now - N 秒` 现算所有日期。同一条对 `relTime` 也成立：写死的时间会让截图上
永远写着「3d ago」。凡是喂给「看一眼对不对」的假数据，时间都必须是相对现在的。

### 一个 UIHostingConfiguration 行，可能整行只暴露成一个可访问性元素（第 13 轮）

所以 UI 用例里不要写 `app.staticTexts["某一行的副标题"]`——SwiftUI 有时把一行的
几个 `Text` 合并成一个元素，有时不合并，取决于构建。判据换成
`app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", …))`：
要断言的是**屏幕上有没有这几个字**，不是可访问性树长什么样。
（这一轮没被它咬到，是先按这个写的；写成前一种大概率会红得莫名其妙。）

### 两个按钮驱动同一个桥方法，结果行必须能分辨（第 13 轮）

`tools/bridge-fixture/index.html` 的结果行原来是 `RESULT <method> ok`。新加一个
「存两条 keyring」的按钮之后，它和旧的 `keychain.set` 打出同一句话，于是老用例的
`fixtureSays("keychain.set ok")` 会被新按钮的回答满足——用例还是绿的，但它已经不再
测原来那件事。`ask()` 因此多了一个只影响显示的 `label` 参数。

### 网页那一半的截图，今天在这台机器上无处可截（第 13 轮，影响「像素比对流程」）

查过了：仓库里**没有任何浏览器测试设施**——`apps/dashboard/package.json` 的依赖里
没有 playwright、puppeteer、storybook、jsdom、happy-dom、testing-library 中的任何一个；
`pnpm dev` 走 `tsx server.ts`，要连 Postgres，而这台 Mac 没有 Postgres 也没有 Docker。
所以「模拟器截图 vs 同视口的网页截图」不是加一个脚本就能跑起来的，它先要有一条
**能在没有数据库的情况下把真组件渲染成 HTML** 的路（见「下一项」）。

### 一个可编译的行视图不等于一个能在 Mac 上看的行视图（第 12 轮）

`SessionRowView` 从第一行就写成「纯 SwiftUI + 一个值类型」，不是风格洁癖：
`tools/render-list.sh` 因此能用 `swiftc -O` 给 macOS 编一遍、5 秒出两张 PNG（明暗两套），
不用模拟器、不用签名、不用服务端。做法照抄第 0 轮就有的 `tools/render-cards.sh`。
**代价是一条纪律**：视图里不能出现 UIKit，包括「顺手」用 `UIColor` 做随配色方案变化的颜色。
所以 `WebContract` 生成的是 `ThemeColor { light, dark }` 而不是一个动态 `UIColor`，
由视图自己 `resolve(colorScheme)` —— 一个 `UIColor { trait in }` 会让这个文件和每个读它的
视图都编不出 macOS，也就等于再也没人看。
另外 `@main` 只能放在**不叫 `main.swift`** 的文件里，`tools/render-list/main.swift`
会报 `'main' attribute cannot be used in a module that contains top-level code`；
`render-cards.swift` 直接放在 `tools/` 下不是随手放的。

### 侧栏的颜色不是 Tailwind 调色板，是 CSS 变量，声明了两遍（第 12 轮）

第 9 轮的生成器只认 `bg-amber-400` 这种调色板类名。而侧栏的行用的是
`text-sidebar-foreground/85`、`text-muted-foreground/60`、`bg-sidebar-accent` ——
这些是 `globals.css` 里的自定义属性，`:root` 一份、`.dark` 一份，浏览器按当前方案挑。
**两个值都得过去**，只抄一份等于把暗色模式钉死。生成器新增 `readThemeVar`，
按 `SOURCES.theme` 读那两个块；`THEME_VARS` 是一张显式清单，只列真的有屏幕在画的四个
—— 那个文件有三十个变量，抄过去没人用的等于抄了一堆没人能验的数字。
**这一步的独立验证不用查表**：这四个今天都是中性灰（chroma = 0），而中性色在
Oklab→线性 sRGB 那一步会塌成三个通道都等于 L³，Display P3 和 sRGB 的中性轴又是同一条，
所以整条转换必须化简成 `gamma(L³)` —— 测试里直接按 sRGB 传输函数算一遍比，
不碰生成器用的任何一个矩阵。

### 「移植一个纯函数先跑一遍」这条，对 JS 的 falsy 尤其成立（第 12 轮，第三次）

`s.title || s.preview || s.agentName` 里，**空字符串的标题会掉到下一个**。
一个刚建、还没起标题的会话，`title` 正好就是空串。所有用非空标题写的样例都看不出这个差别。
`lastMessageAt` 为 null 时 `sessionRecencyAt` 退回 `startedAt` 也一样。
两条都是在 `tools/api-fixture.sh` 里拿**服务端真实那一行 JSON**跑出来看到的，
不是读代码读出来的 —— 那个夹具里第二行专门是「从没说过话的新会话」。
顺带证实了 `SessionListItem` 少声明的那十一个字段真的被 `Decodable` 忽略掉，
而不是让整个响应解不出来。

### 一个新屏先挂在 URL 上，不要一上来就当根（第 12 轮）

`hermit://sessions` 推进栈，`SceneDelegate` 的根还是 `WebViewController`。
换根是一行，但那一行同时把冷启动、离线屏、深链接落点、`AppDelegate.attach(controller)`
全交给新屏 —— 第 11 轮单独换容器就是为了让这类问题一个一个冒出来，这里不该再合并。
代价是这一轮的列表在真机上还没被人点开过，已写进「下一项」的第一条。

## 轮次日志

| 轮 | 时间 | 做了什么 | 构建 |
|---|---|---|---|
| 20 | 2026-09-05 | **M4 时间线骨架：这三个纯函数第一次有调用方，也第一次有东西可看。** 新增 `apps/ios/Hermit/TimelineRowView.swift`（纯 SwiftUI，一个 `FoldedRow` 进；气泡 / 运行胶囊 / 思考胶囊 / 系统药丸 / Brain 虚线框 / ask 卡 / 图片文件 chip / **不认识的块画成写着 type 的灰卡片** / turn-ended 标记）、`apps/ios/Hermit/ChatTimelineViewController.swift`（collection view 竖向翻转、cell 翻回来、diffable 按 `FoldedRow.key`、`chat.listMessages` 取 `WebContract` 那个窗口）、`tools/render-timeline.sh` + `tools/fixtures/timeline-cases.json`（几秒出图，不用模拟器）。`SceneDelegate` 加 `hermit://timeline/<id>`，**没动前门**。生成器 `gen-ios-contract.ts` 加了四个主题色（`background`/`foreground`/`muted`/`border`）和 alpha 支持 —— `--border` 在 `.dark` 里是 `oklch(1 0 0 / 10%)`，老正则解不了 | `xcodegen` + `swiftc -typecheck` **exit 0 无输出**；dashboard `tsc --noEmit` **exit 0**；`src/lib/ios-contract.test.ts` 单独跑 **11/11 过**（含新加的半透明主题色）。三个胶囊标签函数和网页那三个**逐输入对过 30 个，全等** —— 其中 `1250` 一例本来会差（`1.3k` vs `1.2k`，见「踩过的坑」）。**画出来看过两张**：`shots/timeline-dark.png` / `timeline-light.png`，十一种行都对，并且当场看出「发送侧气泡整块右对齐」是错的、改掉了。**没起过模拟器** |
| 19 | 2026-09-05 | **M4 第二条：`foldRuns` 移植成 Swift。** 新增 `apps/ios/Hermit/FoldRuns.swift`（只依赖 Foundation，500 行，含 `isMachineryBlock`/`stepFor`/`closesRunUnconditionally`/`safeSplitIndex`/`summarizeRun`/`isHarnessTerminator` 和「运行块按下面那行取名」的第二遍）、生成器 `scripts/gen-fold-fixture.ts` → `tools/fixtures/fold-cases.json`、驱动 `tools/fold-fixture.sh`。**明确不按上一轮的打算做**：折叠的依据是原始块而不是 `parseBlocks()` 的结果，否则没有 `id` 的 `tool_use` 在手机上可见、在网页上被折走（写进「踩过的坑」）；`FoldedMessage` 因此同时带 `rawBlocks` 和 `blocks`。JS 的三处强制转换（`String(x)`、`??`、`is_error`/`__d` 的真值判断）照抄而不是「顺手改好」。**顺带修掉第 18 轮就上线的一个真 bug**：`ContentBlock.swift` 的 `chars` 用 `body.count` 数字素，网页数的是 UTF-16 码元 | `tools/fold-fixture.sh` **97/97 过**，**反证做过五次**（去掉 ask 豁免 → 只红 3 条 `isMachineryBlock[ask/*]` + `ask-stays-visible` + `digestInvariance`；运行块改按上面那行取名 → 红 20 条折叠；`chars` 改数字素 → 只红 `coercions`；`is_error` 改成只认字面 `true` → 只红 `coercions`；关掉跨天断开 → 只红 `run-never-spans-a-date-divider` 和 `unparseable-timestamp-closes-the-run`），逐个恢复后全绿。夹具里两条性质**真的验过**：11 个接缝逐个分两半折 == 整体折；摘要后的内容折出的折叠态与网页用完整内容折出的逐字段相同。块夹具加了 `好👍` / `é` 两例后 `tools/blocks-fixture.sh` 先红后绿（**73/73 → 75/75**）。`xcodegen` + `swiftc -typecheck` **exit 0 无输出**；dashboard `tsc --noEmit` **exit 0 无输出**（先补 `src/generated/prisma` 软链，见「踩过的坑」）。无界面改动，未截图；**没起过模拟器** |
| 18 | 2026-09-05 | **开 M4：消息块有定义了。** 新增 `apps/dashboard/src/lib/chat-blocks.ts`（`WireContentBlock` 只校验、原样交还，给写入口；`parseBlocks()` 是读的那一面，判别联合，unknown 一支显式）、`apps/ios/Hermit/ContentBlock.swift`（只依赖 Foundation，含一个 `JSONValue` 给 `input`/`content`/`payload` 这三个谁都不约束的字段）、生成器 `scripts/gen-blocks-fixture.ts` → `tools/fixtures/block-cases.json`（53 块 + 9 个整列）、驱动 `tools/blocks-fixture.sh`。联合**不可能失败**：匹配不上就是 `unknown` 并带着生产者自己那个 type 字符串，这正是 M4 最后一条的灰卡片要的。网页端接了三处：`chat.send` 以 `WireContentBlock` 拼块、`extractSearchText` 和 `msgText` 换成共用读法；时间线组件仍留宽松 `Block`，理由写在注释里。**发现 `routers/chat.ts:41` 的块级联合是死代码**（零引用） | `tools/blocks-fixture.sh` **73/73 过**，反证做过（塞三处偏差 → 正好红在对应用例上，恢复后全绿）；`xcodegen` + `swiftc -typecheck` **exit 0 无输出**；dashboard `tsc --noEmit` **exit 0 无输出**（先 `prisma generate`）；改到的两个纯函数各自驱动过 —— `chat-text.test.ts` **8/8 过**，`msgText` 与被它替换掉的那份实现在 20 种真实形状上**逐条相同**。另跑了一次模拟器补第 17 轮欠的确认：`testTheNativeListDrawsTheActiveMachinesSessions` 过，`shots/16`、`17`、`18` **亲眼看过**，真列表行距 **52.33pt 完全均匀**（比对那张是 49.5，差 2.83 写进「踩过的坑」）。收工 `simctl list devices booted` 为空 |
| 0 | 2026-09-04 | 建这个文件，拆出 M0–M7 的清单 | 未改代码 |
| 17 | 2026-09-05 | **把第 16 轮量出来的行错位修掉：10.10%/10.03% → 4.33%/4.29%，误差不再逐行累积。** 根因是网页的行高压根不在这一行的 class 里（Tailwind preflight 的 `line-height: 1.5`），所以 `SessionRowView` 新增 `RowMetrics`（`titleLine` 19.5 / `metaLine` 15 / `lineGap` 2 / `padV` 6 / `box` 48.5 / `pitch` 49.5），两行各自 `.frame(height:)` 到网页的行盒；补上 `space-y-px` 的 1pt（做成行自己的下外边距，所以列表和 `render-list.sh` 共用一份）；选中行圆角 `.continuous` → `.circular`。`StatusDot` 认 Reduce Motion，另加一个 `\.hermitStillFrame` 环境值给静帧渲染器（`accessibilityReduceMotion` 只读，设不了）。`render-list.swift` 的画布改成按行距算的整数高度，`render-session-rows.tsx` 把 body 也刷成 `--sidebar`，两张图因此同尺寸。新增 `HERMIT_MEASURE=1 tools/render-web-list.sh`：打印 Chrome 自己量的每个元素盒子 | `xcodegen` + `swiftc -typecheck` **exit 0 无输出**；dashboard `tsc --noEmit` **exit 0 无输出**（先 `prisma generate`）；`tools/pixel-compare.sh` 跑了四遍，**10.10%/10.03% → 4.33%/4.29%**，热力图**亲眼看过**：十一行的点和文字全部各就各位，不再逐行错开，浅色那张原生渲染也逐行看过。四个满色的状态点改完**逐字节相同**（`(255,185,0)`/`(0,188,255)`/`(255,32,86)`/`(0,188,125)`，改之前脉动的三个只有 50% 强度）。剩下的 4.3% 逐项量过并写进「下一项」：字形本身、等宽字体宽 3%（`.AppleSystemUIFontMonospaced` 步进 6.1816 对浏览器的 6.0，**`.tracking(0)` 试过，一个像素都没变**）、`/50` `/30` 两个点各差一个通道。**没起过模拟器**，收工 `simctl list devices booted` 为空、无残留 Chrome |
| 16 | 2026-09-05 | **M3 收官：像素比对流程。** `tools/pixel-compare.sh` 一条命令 33 秒：`render-list.sh` 画原生、新增的 `render-web-list.sh` 画网页、新增的 `tools/png-diff.swift` 逐像素比，热力图落 `shots/`。网页那半是新增的 `apps/dashboard/scripts/render-session-rows.tsx`：`react-dom/server` 渲染**真的那个行组件**＋`@tailwindcss/postcss` 编出的 CSS 内联，再用 `/Applications` 的 Chrome `--headless=new` 截图；为此把 `SessionRow` 从 `recent-lists.tsx` 抬进 `components/sidebar/session-row.tsx`（原文件 import 时就要 trpc 客户端和 Next 路由 hook）。两边吃同一份新增的 `tools/fixtures/session-rows.json`（11 行，时间写成「多少秒之前」），共享一个 `HERMIT_FIXTURE_NOW`；`render-list.swift` 的 SAMPLES 因此从写死改成读这份夹具 | `xcodegen` + `swiftc -typecheck` **exit 0**；dashboard `tsc --noEmit` **0 错**；`tools/pixel-compare.sh` **真跑通了两遍**，明暗各 960x1455、**10.10% / 10.03% 像素不一致**，热力图**亲眼看过**：第一行几乎重合、之后每行错开约 4pt 一路累积，到第八行整整错开一行 —— 结论是原生行比网页行矮，已写进「下一项」。过程中比对**自己先抓到一个夹具 bug**（网页那半从没联系过 dashboard，`dashboardReach()` 回 0＝「没有依据」，于是不判 stale，而 Swift 默认联系正常）：补上一小时正常联系记录后 11 行状态逐行一致，已逐条核对（working/background/unread/ready/starting/restarting/stale/asleep/closed/ready/ready）。`png-diff` 第一版写出的是一整张白图，改成直写字节后重跑才看见上面那些结论。**没起过模拟器**，收工 `simctl list devices booted` 为空、无残留 Chrome |
| 15 | 2026-09-05 | **M3 倒数第二条：会话列表成了前门。** `SceneDelegate` 的根从 `WebViewController` 换成 `SessionListViewController`，网页改成按需 push；网页那一份实例由 scene 强持有（栈只是借走，见「踩过的坑」），启动时就 `loadViewIfNeeded()` 预热。keyring 为空时冷启动仍然无动画直接进网页（登录闸门和换服务器都在那边）。新增 `Hermit/SessionListCache.swift`：`lib/session-list-cache.ts` 的移植，Application Support 里每个 keyring 条目一个 JSON、20 秒节流、空列表读回来当没有，`SessionListItem` 因此加了 `Encodable`、`HermitAPI` 加了与 `decoder` 严格互逆的 `encoder`（带毫秒）。`AppDelegate` 不再持有 `WebViewController` 而是一个 `AppShell`（token 不动屏幕、path 要把网页带到前面）。列表加 `New chat`（`/chat?new=1`）和点开即高亮；返回靠边缘手势（要自己开，见「踩过的坑」）。假页面加一个「同 id、坏 token」的 keyring 按钮 | `xcodegen` + `swiftc -typecheck` **exit 0**；**模拟器上跑过**：五条 UI 用例（新增 `testTheSessionListIsTheFrontDoor`，其余四条因为换根全部改写）**163 秒全过**，加行点击覆盖后新用例单独重跑 42 秒也过；**反证做过**：把读快照那行 `if false` 掉，用例正好卡在「the front door drew nothing — the cold-start snapshot never painted」，恢复后通过。`shots/20`（冷启动只有快照、拉取被 401 挡住）和 `shots/21`（点开一行再返回，首行高亮、状态色齐全）两张亲眼看过。dashboard 未改动，未跑它的 typecheck。收工 `simctl list devices booted` 为空 |
| 14 | 2026-09-05 | **前门那一条的两个前提**：会话列表开始自己刷新，并且只在它在屏幕上的时候刷新 —— `viewWillAppear` 起 5 秒定时器（`tolerance=1`，照抄网页的 `refetchInterval: 5_000`）、`viewWillDisappear` 停、`didEnterBackground` 停、`willEnterForeground` 立刻拉一次再起（网页那半是 React Query 的 `refetchIntervalInBackground` 默认 false）。轮询逼出一个只手动刷新时看不见的 bug：diffable 的标识符从行值换成会话 id，变了的行 `reconfigureItems` 原地重画，否则每 5 秒整屏删了重插。在飞的请求不会被轮询挤掉，下拉刷新/回前台才顶掉它；**轮询失败不动已经画好的列表**。另加 `Hermit/SessionListSkeleton.swift`（网页那六条 `h-8 rounded-md bg-sidebar-accent/40 animate-pulse`，纯 SwiftUI，`render-list.sh` 多出两张图），空态/错误文案改成网页的排版和原句。假服务端多一个「这是第几次回答」的计数行 | `xcodegen` + `swiftc -typecheck` **exit 0**；**模拟器上跑过**：新用例 `testTheNativeListRefreshesItselfWhileYouWatch` 36 秒过（不碰屏幕等到计数 +2 = 定时器在跑；退回网页等 12 秒再进来，计数只涨 1 = 定时器停了），旧的 `testTheNativeListDrawsTheActiveMachinesSessions` 回归重跑也过（改了共享夹具，必须回归），两条合计 68 秒；**反证做过**：`startPolling` 改成直接 return，用例正好卡在「the list never refetched by itself」，恢复后再跑通过。`shots/19` 亲眼看过（11 行画全、最后一行 `poll #6`、各状态点色不变），`session-list-loading-{dark,light}` 两张也看过（浅色那张几乎看不见，和网页一致，见「踩过的坑」）。dashboard 未改动，未跑它的 typecheck。收工 `simctl list devices booted` 为空 |
| 13 | 2026-09-05 | **上一轮那两条终于是真的了**：会话列表第一次在模拟器上跑起来。`tools/bridge-fixture/` 从 `python3 -m http.server` 换成自己的 `server.py`——静态页面照旧，外加一条 `chat.listSessions`，而且**按 `x-asst-key` 给不同答案**（`key-one`→第一行标题写 `active key: m_one`，`key-two`→`m_two`，认不出的 key→401 的 tRPC 错误形状）。假页面加三个按钮（存两条 keyring、把活动项指到 m_two / m_one），`ask()` 多一个只影响显示的 `label` 参数。新 UI 用例 `testTheNativeListDrawsTheActiveMachinesSessions`：装 keyring → 指定活动项 → `XCUIDevice.shared.system.open("hermit://sessions")` → 断言第一行 → 退回去换一台机器 → 再开一次 → 登出看空态。**没有为测试给产品开后门**，走的就是 `SceneDelegate` 那个 URL。夹具的日期全部按请求现算（见「踩过的坑」） | `xcodegen` + `swiftc -typecheck` **exit 0**；**模拟器上跑过**：新用例 31 秒通过，旧的 `testTheKeychainKeepsTheKeyring` + `testThePageCanProposeAnotherServer` 回归重跑 41 秒也过（改了共享夹具，必须回归）；`shots/16..18` 三张**逐张亲眼看过**——十行状态各自的点色与透明度对得上（amber 脉动 / amber 暗 / rose / emerald / zinc stale / sky starting / emerald-30 asleep / zinc closed）、空标题掉到 preview（`帮我看看这个构建为什么挂了`）、长中文标题截断、月亮与眼睛两个 12pt 标记、归档与隐藏的整行透明度、等宽副标题；**换活动项之后第一行从 `m_two` 变成 `m_one`**，证明 key 是每次请求现读的、`list[0]` 兜底没有抢答；空 keyring 的那张写着「No machine key on this device yet.」。dashboard 未改动，未跑它的 typecheck。收工 `simctl list devices booted` 为空 |
| 12 | 2026-09-05 | **M3 第三、四条**：原生会话列表。`Hermit/SessionListItem.swift`（`chat.listSessions` 的行 + `relTime`/未读/recency 三个纯函数移植）、`Hermit/SessionRowView.swift`（纯 SwiftUI 行视图，逐个 Tailwind 类当 CSS 像素读）、`Hermit/SessionListViewController.swift`（`UICollectionView` list + `UIHostingConfiguration`，一个 `chat.listSessions`、不重排、下拉刷新、失败把错误原文写在屏幕上）。**红线跨过去了**：`Hermit/KeyStore.swift` 是全 App 唯一打开 keyring 的地方，`HermitAPI`/`HermitStream` 仍只收闭包；11 处红线文字同一提交改掉。方法表加 `keychain.setActive`（网页 `setActiveMachine`/`addScopedMachine`/`hydrateKeyring` 推过来，存 `<origin>#active`），解决了上一轮记下的「哪一条是活动的」。生成器加 `readThemeVar` + `ThemeColor`，把 `--sidebar`/`--sidebar-foreground`/`--sidebar-accent`/`--muted-foreground` 的明暗两套带过来。新增 `tools/render-list.sh`（Mac 端 5 秒出图，不用模拟器）| `xcodegen` + `swiftc -typecheck` **exit 0**（故意写错的临时文件反证过它真在检查）；`tools/api-fixture.sh` 加了一条**服务端真实形状**的 `chat.listSessions`，两行都逐字段核对过（空标题掉到 agentName、无消息的会话 recency 退回 startedAt、未读判定、dot=`bg-amber-400` / `bg-emerald-500/30`），十一个未声明字段被忽略而不是解不出来；`ios-contract.test.ts` **11/11**（新增 4 条），**反证做过**：把行视图里的颜色改回字面量，只红了「行视图仍从 contract 读颜色」那一条，恢复后全绿；dashboard `tsc --noEmit` **0 错**；`tools/render-list.sh` 出图，**明暗两张都亲眼看过**——九种状态色、`/50` 与 `/30` 的透明度、标题截断、图钉/眼睛/月亮三个 12pt 标记、归档与隐藏的整行透明度都对；`render-cards.sh` 回归重跑没退化。**没起过模拟器**，收工 `simctl list devices booted` 为空 |
| 11 | 2026-09-05 | M3 第一条 + 第二条的前提：`SceneDelegate` 换成 `UINavigationController` 当根（栈里仍只有 `WebViewController`，导航栏隐藏），三处 `rootViewController as? WebViewController` 强转合并成一个「在栈里找」的访问器；`Hermit/SessionStatus.swift`（441 行）把 `lib/session-status.ts` 的判定阶梯连同 `shortDuration`/`activityLabel`/`backgroundSummary`/`backgroundTaskList`/`backgroundStillRunning`/`snapshotSilenceMs` 移植过来，`SessionActivity` 从 `HermitStream.swift` 搬进来，`StatusView.dot` 保留网页的 Tailwind 类名原文、`StatusPalette.dot` 负责转颜色（含 `/50`、`/30` 的透明度）。生成器加两个阈值（`SNAPSHOT_STALE_MS`/`BACKGROUND_RESIDENT_MS`，毫秒）。新增 `scripts/gen-status-fixture.ts` + `tools/fixtures/status-cases.json` + `tools/status-fixture.sh` + `src/lib/status-fixture.test.ts` | `xcodegen` + `swiftc -typecheck` **exit 0**（故意写错的临时文件反证过它真在检查）；`tools/status-fixture.sh` **213/213**（20 条时长 + 22 条 activity 逐项比 label/summary/tasks + 30 条状态逐字段比 key/label/dot/pulse/detail，再加 silence 与配色查表）；**四个反证做过，四个都如期只红了预期那几条**（关掉 JS 数字格式化 → 12 条时长；unread 排到 asleep 之后 → 只红 `unread-beats-asleep`；45 秒边界改成闭区间 → 只红 `stale-boundary-just-under`；空字符串当有效 label → 只红 `tool-empty-label`），恢复后全绿；dashboard `tsc --noEmit` **0 错**，`status-fixture` + `ios-contract` **10/10**；**模拟器上跑过** `tools/bridge-fixture.sh` 2 个 UI 用例 41 秒全过，截图 `shots/11` 亲眼看过——页面仍是满屏、没有多出导航栏、安全区没有变。收工 `simctl list devices booted` 为空 |
| 10 | 2026-09-05 | **M2 完成**：本地存储 `Hermit/ChatCache.swift`（SQLite + FTS5 `trigram`，`libsqlite3` 直调，无第三方依赖）与 `Hermit/SyncPlan.swift`（`planSync` 移植）。分词器是量出来的：`unicode61` 对每个中文查询 0 行，`trigram` 与线性 `indexOf` 同解、检索 0.0–0.3ms vs 1.8–2.5ms；**少于 3 字符的查询 trigram 静默答 0 行**，`canUseIndex` 一票否决走扫描。索引只缩小范围，命中行一律在 Swift 里按网页的 `indexOf` 规则重核，片段偏移是 UTF-16 码元。搜索的三个常量（`SNIPPET_PAD`/`DEFAULT_PAGE`/`MAX_MATCHES_PER_ROW`）并入第 9 轮的生成器。新增两个生成器 + 两张共享对照表 + `tools/cache-fixture.sh` | `xcodegen` + `swiftc -typecheck` **exit 0**（用故意写错的临时文件反证过它真在检查）；`tools/cache-fixture.sh` **502/502 条检查过**（22 例 planSync + 22 例 search 逐字段比片段/高亮/计数 + 分词器实测 + FTS5 `integrity-check, 1`）；**四个反证做过，三个如期变红**（片段窗口差 1、换回 `unicode61`、`INSERT OR REPLACE`），第四个（稳定排序）红不了并已写进「踩过的坑」；dashboard `tsc --noEmit` **0 错**，`ios-contract` + `chat-cache` 全部单测 **57/57**。无界面改动（`WebContract.swift` 只增三个 Int，颜色一字未动），未截图；没起过模拟器 |
| 9 | 2026-09-05 | M2 的「防漂移」：新增生成器 `apps/dashboard/scripts/gen-ios-contract.ts` 和生成物 `apps/ios/Shared/WebContract.swift`（14 个成员），`StatusPalette` / `HermitStream` / `LiveActivityManager` 改成读它，Swift 侧不再有手抄的数字。**修掉那处已知漂移**：`workingStaleAfter` 10 分钟 → 服务端的 15 分钟。颜色由 `session-status.ts` / `ctx-bar.tsx` 里的 Tailwind 类名经 `tailwindcss/theme.css` 的 oklch 转 Display P3 得到。新增 `apps/dashboard/src/lib/ios-contract.test.ts`（7 条）。`render-cards.sh` 的文件清单同步 | `xcodegen` + `swiftc -typecheck` **exit 0 无输出**（并用一个故意写错的临时文件反证过它真在检查）；`ios-contract.test.ts` **7/7 过**，且**两次故意制造漂移都只红了预期的那一条**、恢复后全绿；dashboard `tsc --noEmit` **0 错**（先 prisma generate）；`tools/render-cards.sh` 编过并出图，与改动前的五张**逐像素比对：最多 0.12% 的像素差 1/255**，即生成的调色板没改变屏幕；`expanded-question.png` 亲眼看过（amber 的「去回答」、55% 的 emerald ctx 条）。**没起过模拟器** |
| 8 | 2026-09-05 | M2 的 SSE 客户端：`Hermit/HermitStream.swift`（576 行）—— `URLSession.bytes(for:)` 的字节流，退避 `[1s,2s,5s]`、35 秒僵尸看门狗、首连 `skipInitial=1` 重连不带，`messages`/`status` 两种帧走一条 unbounded 的 `AsyncStream`；401/404 不再重连（复用 `HermitAPIError.isRetriable`）；补了 `SessionStatusFrame`/`SessionActivity`/`TimelineWindow`；`HermitAPI.decoder` 由 private 改共享，全 App 只有一份 ISO-8601 解析。另加 `tools/stream-fixture.sh` + `tools/stream-fixture/`（会真推 SSE 的假 dashboard，15 秒，四个场景）。**红线未动，仍然没有一处构造 `HermitStream`** | `xcodegen` + `swiftc -typecheck` **0 warning 0 error**；`tools/stream-fixture.sh` **真跑过，每一条事件都亲眼核对**：`{rows,gone}` 与裸数组两种形状都解、中文和 `&`/`<b>` 原样、带毫秒和不带毫秒的 Date 都解、`activity` 是字符串时只丢活动不丢 `state`、坏 JSON 和类型不符各出一条 `frameDropped`（后者报到 `rows[0].id`）而流不断、**被拆成两个包中间隔 150ms 的帧正确重组**、未知 `event: typing` 静默跳过、`: ping` 不产生事件；服务端请求日志确认重连那条**没有** `skipInitial`、`x-asst-key` 到位且无 cookie；看门狗按 1 秒的截止时间准点开火；401 只发了一次请求然后序列结束。`tools/api-fixture.sh` 回归重跑，无退化。dashboard 未改动，未跑它的 typecheck；无界面改动，未截图 |
| 7 | 2026-09-05 | M2 前两条：`Hermit/HermitAPI.swift`（352 行）—— tRPC over HTTP 的 `query`/`mutate`，成功读 `j[0].result.data.json`、失败先解 `j[0].error.json` 再退回 HTTP 状态码，`URLError` 不包装，`HermitAPIError` 带 `isUnauthorized`/`isRetriable`，`ephemeral` 会话（无 cookie、无缓存、不等联网、30 秒）；superjson 的 `meta` 整块不声明，Date 走两档 ISO8601 解码。**key 是构造时传进来的闭包，全仓没有一处构造它，红线未动。** 另加 `tools/api-fixture.sh` + `tools/api-fixture/`（假 dashboard，8 秒，不用模拟器/key/网络） | `xcodegen` + `swiftc -typecheck` 过；`tools/api-fixture.sh` **真跑过，7 条请求全部亲眼核对**：GET 的 `input=` 编码、POST 的 body、`x-asst-key` 送到、无 cookie；带毫秒和不带毫秒的两种 Date 都解出来；401 出 `UNAUTHORIZED: invalid key`（retriable=false）、502 HTML 出 `HTTP 502`（retriable=true）、非 batch 正文和坏日期都出 `unreadable response`、死端口出 `URLError(-1004)` 而不是 `HermitAPIError`。`percentEncoded` 与 node 的 `encodeURIComponent` 四组输入**逐字节相同**。dashboard 未改动，未跑它的 typecheck；无界面改动，未截图 |
| 6 | 2026-09-05 | M1 的服务端幂等键：`chat.send` 加可选 `clientId`，`ChatMessage` 加 `clientId` 列 + `@@unique([sessionId, clientId])`，重复请求在做任何副作用之前返回已存在那行，并发插入撞唯一索引走 P2002 回读；手写迁移 `20260905090000_chatmessage_client_id`。顺带确认 A2 不需要 App Group、真正的前提是「谁发重试」 | `prisma generate` + dashboard `tsc --noEmit` **0 错**；`prisma migrate diff --from-empty --script`（不连库）打出的 SQL 与手写迁移**逐字一致**；`xcodegen` + `swiftc -typecheck` 过（iOS 未改动）。**没有数据库可跑，重复发送的行为本身没被真的驱动过**；无界面改动，未截图 |
| 5 | 2026-09-04 | M1 的 A1 Keychain：`Hermit/Keychain.swift` + `keychain.get/.set/.clear`（判据是主框架 URL 与 `AppConfig.origin` 精确同源，账号按 origin 分条）；`keyring.ts` 的 `read()`/`write()` 改走内存副本 + `hydrateKeyring()`（写→读回校验→才清 localStorage），`auth-gate.tsx` 在渲染前 await；11 处红线文字同一提交改掉；`bridge-fixture.sh`/`smoke.sh` 改 ad-hoc 签名 | `xcodegen` + `swiftc -typecheck` 过；dashboard `tsc --noEmit` **0 错**；`tools/bridge-fixture.sh` **2 个 UI 用例 41 秒全过**（新增 `testTheKeychainKeepsTheKeyring`，旧的 `testThePageCanProposeAnotherServer` 未回归）；截图 `shots/14`、`15` 看过：重启后 `keychain.get` 回 `{"value":"keyring-marker-42"}`。收工 `simctl list devices booted` 为空 |
| 4 | 2026-09-04 | M1 的第一个真 method：`WebViewController.answer()` 方法表 + `getOrigin` / `setOrigin`（页面只能提议，人确认）；`tools/bridge-fixture.sh` + `tools/bridge-fixture/`（不用 key、不用网络的真页面） | `xcodegen` + `swiftc -typecheck` 过；`xcodebuild build-for-testing` 过；UI 用例 `testThePageCanProposeAnotherServer` **22 秒通过，同一份代码跑了两遍**；3 张截图（`shots/11..13`，gitignore）逐张看过：确认框写着 `:49518 → :49517`，第二次启动的离线屏写着 `:49517`。收工 `simctl list devices booted` 为空 |
| 3 | 2026-09-04 | M0 最后一条（两边都拒封禁端口）+ M1 A0（桥的问答通道，双向 5 秒超时）| `xcodegen` + `swiftc -typecheck` 过；`xcodebuild test -only-testing:HermitTests` **47/47 过**（新增 9 条）；dashboard `tsc --noEmit` **0 错**（先 prisma generate，见「踩过的坑」）；`api-base.test.ts` 16/16 过。无新界面，未截图 |
| 2 | 2026-09-04 | M0 第 2、3 条：离线屏加 "Change server"（并显示试的是哪个地址）、`hermit://server`、`presentOriginEditor` + `switchOrigin`；新增 UI 用例 `testServerAddressCanBeChanged` | `xcodegen` + `swiftc -typecheck` 过、`xcodebuild build` 0 warning；UI 用例 13 秒通过，4 张截图在 `apps/ios/shots/07..10`，逐张看过 |
| 1 | 2026-09-04 | M0 第 1、4、5 条：`AppConfig.origin` 成了 UserDefaults 里的值（两个键 + `normalizeOrigin`），单测从 22 条加到 35 条 | typecheck 过；`xcodebuild test -only-testing:HermitTests` 35/35 过；无界面改动，未截图 |
