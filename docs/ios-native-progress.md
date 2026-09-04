# iOS 原生化 — 进展

**这个文件是每轮之间唯一的记忆。** 每小时一轮的 cron 先读它，再接着做，收尾时写回来。
方案在 `docs/ios-native-design.md`。

## 目标（sway 2026-09-04）

**全部原生。** 这明确覆盖了设计文档里「不要全原生、第三段设闸门」那条建议 ——
文档保留原样不改，因为它记录的成本估算仍然成立，只是决定不同了。

- **静态呈现要和网页一致**：布局、间距、字号、颜色、状态色、空态文案，逐屏截图比对。
- **交互按 iOS 平台惯例**：滚动惯性、回弹、键盘避让、返回手势、长按菜单，
  照抄网页的物理反而会把做原生的理由抵消掉。这条如果 sway 有不同意见，以他为准。

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
   CODE_SIGNING_ALLOWED=NO`（约 50 秒，首轮含全量构建约 2 分钟），跑完 `xcrun simctl shutdown all`。
4. 改了看得见的界面才出截图（`tools/render-cards.sh` 只画 Live Activity 卡片，
   画不了 App 的屏；要 App 的屏就得上模拟器）；跑完确认
   `xcrun simctl list devices booted` 为空，并 `simctl erase` 掉自己开的那台。
   **不需要 key、不需要网络的一屏**可以只跑单个 UI 用例，13 秒：
   `xcodebuild build-for-testing …` 然后
   `TEST_RUNNER_HERMIT_SHOT_DIR=$PWD/shots xcodebuild test-without-building … \
   -only-testing:HermitUITests/SmokeTests/<用例名>`。
   `shots/` 是 gitignore 的（截图不进仓库），所以 M7 那批要单独交给 sway。
5. 回来更新这个文件：勾掉做完的、重写「下一项」、把踩到的坑写进最下面那节。

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
- [ ] **A1 Keychain**：接缝只有 `keyring.ts:29`（读）和 `:36`（写）。
      `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`、不同步 iCloud、不进备份、
      放 App Group。迁移顺序：写入 → **读回校验** → 才清 localStorage。登出连带清 Keychain
- [ ] **服务端幂等键**（必须先于出站队列）：`chat.send`（`routers/chat.ts:1121`）加可选
      `clientId`，`ChatMessage` 加 `@@unique([sessionId, clientId])`，重复请求返回已存在那行
- [ ] **A2 出站队列**：App Group 里一个 append-only JSON 行文件即可，不要数据库。
      重试时机 `NWPathMonitor` + 回前台 + `BGAppRefreshTask`
- [ ] 红线文字更新（6 处）：`apps/ios/README.md:109`、`NativeBridge.swift:6`、
      `LiveActivityManager.swift:19`、`HermitLiveActivityBundle.swift:6`、
      `AppConfig.swift:26`、`native-bridge.ts:5`；`PrivacyInfo.xcprivacy` 复核

## M2 — 原生网络层与数据层

- [ ] `HermitAPI.swift`：tRPC over HTTP。
      查询 `GET /api/trpc/<proc>?batch=1&input=<urlencoded {"0":{"json":…}}>`，
      变更 `POST` 同路径、body `{"0":{"json":{…}}}`，头 `x-asst-key`，读 `j[0].result.data.json`。
      照抄现成的两份：`lib/keyring.ts:140-176`、`apps/gateway/src/api.ts:150-214`
- [ ] **superjson 的 meta 整块忽略** —— Date 在 `json` 里就是 ISO 字符串，
      Swift 声明成 `Date` 配 ISO8601 解码即可。全仓返回值没有 Map/Set/BigInt
- [ ] SSE 客户端：`URLSession` 的 bytes 流（不能用现成 SSE 库，要能设 header）。
      退避 `[1s,2s,5s]`，35 秒无字节的僵尸看门狗，首连 `skipInitial=1`、重连不带。
      帧只有两种：`messages`（`delta=1` 时是 `{rows,gone}`）和 `status`，**都是纯 JSON**
- [ ] 本地存储：SQLite + FTS5（中文语料上严格优于现在的线性 `indexOf`）。
      `lib/chat-cache/sync-plan.ts` 的 `planSync` 55 行纯函数**原样照抄**，连测试一起
- [ ] **防漂移**：把手抄的常量改成生成的（`StatusPalette.swift` ← `lib/session-status.ts`
      + `ctx-bar.tsx`；超时值 ← `push/live-activity.ts`），断言写成
      `apps/dashboard/src/lib/ios-contract.test.ts`（`pnpm test` 已经在跑这个目录）。
      **已知漂了一处**：`LiveActivityManager.swift:36` 是 10 分钟，
      `push/live-activity.ts:61` 的 `WORKING_STALE_MS` 是 15 分钟

## M3 — 前门

- [ ] `UINavigationController` 当根容器，替换 `SceneDelegate.swift:10-14`。
      同文件三处强转要一起改：`:18` 交给 `AppDelegate.attach`、`:39`、`:49`。
      **改漏了不会报错**，只是深链接不跳、音频会话不放
- [ ] 原生会话列表：`UICollectionView` + `UIHostingConfiguration`，直接复用现成的
      `Shared/SessionCard.swift`、`Shared/StatusPalette.swift`、
      `LiveActivity/SessionCardViews.swift`（364 行 SwiftUI，只 import SwiftUI）
- [ ] 只发**一个** tRPC 查询 `chat.listSessions`，排序/分组规则不要在 Swift 里重新发明
- [ ] 冷启动先画 App Group 里的本地快照，同时后台预热 WebView
- [ ] **像素比对流程**：模拟器截图 vs 同视口的网页截图，建一个可复跑的脚本，
      结果存 `apps/ios/shots/`。这一步做完，后面每一屏都用它验收

## M4 — 时间线（最贵的一块）

- [ ] **消息块的真 schema**（先于一切渲染）。今天没有：服务端 zod 是带 `.passthrough()`
      的宽松联合（`routers/chat.ts:41-57`），`image`/`file`/`interaction` 直接放行；
      客户端 `components/chat/lib.ts:28` 的 `Block` 是全可选 + `any` 的袋子。
      做成 zod 判别联合 + Swift `enum ContentBlock: Decodable`，**网页端也要改用它**
- [ ] `foldRuns`（`components/chat/fold-runs.ts` 323 行纯函数）移植成 Swift；
      把 TS 那 398 行测试的输入输出导成共享 JSON 夹具，两边跑同一份
- [ ] markdown 渲染：GFM 表格、围栏代码、14 种语言高亮（bash css diff go javascript
      json markdown plaintext python rust sql typescript xml yaml）。
      **没有数学公式、没有 mermaid** —— 这是省下来的范围。
      注意这一步会终结「零第三方依赖」
- [ ] 倒置 `UICollectionView` 的时间线（每个 cell 也翻转），把「向上插入历史」变成
      「向下追加」；分页 + `nextId` 空洞证明（`lib/chat-cache/types.ts:47-68`）
- [ ] 两级保真：digest / full，展开胶囊时 `chat.getMessages` 取真实体
- [ ] 交互卡片：`kind: permission | question`，`status`、`decision`、`answeredBy`
- [ ] 图片 / 文件块 + lightbox（`QLPreviewController`）
- [ ] **不认识的块类型画成写着类型名的灰卡片**，不能画成空白 ——
      沿用 `SessionCard.swift:33-45` 那条既有纪律

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
- [ ] 文档更新：`apps/ios/README.md` 的「Everything else is the existing web app,
      unmodified」、`docs/ios-shell-design.md:5` 的 non-goals

---

## 下一项（下一轮从这里开始）

M0 全部做完，M1 的 A0 也做完了。下一轮从 A1 的**前置**开始，别直接写 Keychain。

- **先给 A0 挂上第一个真 method，把通道从「测试里能跑」变成「产品里在用」。**
  最小、最有用的那个是 `setOrigin`：`WebViewController` 里设 `bridge.onRequest`，
  `method == "setOrigin"` 时调 `AppConfig.setOrigin` + `switchOrigin()`，
  失败把 `OriginError.message` 原样放进 `payload.error`。
  这样「从正常页面里改服务器地址」终于有了第三个入口（前两个是离线屏和 `hermit://server`）。
  **要先想清楚一件事再动手**：主框架页面能改壳指向哪，而麦克风授权是按
  `AppConfig.host` 精确比对的 —— 页面被打穿就等于壳被永久改指向。
  网页那侧现在没有任何地方调 `nativeRequest`，所以先加原生侧 + 一个 UI 用例即可。
- **A1 Keychain**。接缝仍然只有 `keyring.ts:29`（读）和 `:36`（写）。
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`、不同步 iCloud、不进备份、放 App Group。
  迁移顺序：写入 → **读回校验** → 才清 localStorage。登出连带清 Keychain。
  网页侧用 `nativeRequest('keychain.get' | 'keychain.set')`，浏览器里 reject，
  调用点必须有 localStorage 兜底 —— 同一份代码在浏览器里也要跑。

## 踩过的坑

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

---

## 轮次日志

| 轮 | 时间 | 做了什么 | 构建 |
|---|---|---|---|
| 0 | 2026-09-04 | 建这个文件，拆出 M0–M7 的清单 | 未改代码 |
| 3 | 2026-09-04 | M0 最后一条（两边都拒封禁端口）+ M1 A0（桥的问答通道，双向 5 秒超时）| `xcodegen` + `swiftc -typecheck` 过；`xcodebuild test -only-testing:HermitTests` **47/47 过**（新增 9 条）；dashboard `tsc --noEmit` **0 错**（先 prisma generate，见「踩过的坑」）；`api-base.test.ts` 16/16 过。无新界面，未截图 |
| 2 | 2026-09-04 | M0 第 2、3 条：离线屏加 "Change server"（并显示试的是哪个地址）、`hermit://server`、`presentOriginEditor` + `switchOrigin`；新增 UI 用例 `testServerAddressCanBeChanged` | `xcodegen` + `swiftc -typecheck` 过、`xcodebuild build` 0 warning；UI 用例 13 秒通过，4 张截图在 `apps/ios/shots/07..10`，逐张看过 |
| 1 | 2026-09-04 | M0 第 1、4、5 条：`AppConfig.origin` 成了 UserDefaults 里的值（两个键 + `normalizeOrigin`），单测从 22 条加到 35 条 | typecheck 过；`xcodebuild test -only-testing:HermitTests` 35/35 过；无界面改动，未截图 |
