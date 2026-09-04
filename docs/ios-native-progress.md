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
4. 改了看得见的界面才出截图（`tools/render-cards.sh`，或 `smoke.sh` 上模拟器）；
   跑完确认 `xcrun simctl list devices booted` 为空。
5. 回来更新这个文件：勾掉做完的、重写「下一项」、把踩到的坑写进最下面那节。

---

## M0 — 迁移保险（最高优先，不做会出事）

`dash.swaylab.ai` 后续并入 `hermit`。`AppConfig.origin` 是编译期常量，而麦克风授权是
`guard origin.host == AppConfig.host`（`WebViewController.swift:252`，**精确比对，不走
`isInternal`**）。迁移之后旧包麦克风直接 deny，网页侧 `canOpenMicSilently()` 在壳里返回
true，不会退回弹框。麦克风是这个 App 最初唯一的存在理由。

- [ ] `AppConfig.origin` 改成 UserDefaults 里的值，默认仍是编译期常量；
      校验照抄 `apps/dashboard/src/lib/api-base.ts:28-44` 的 `normalizeBase()`
      （必须是裸 origin、非 localhost 必须 https）
- [ ] 一个改 origin 的入口（先做最简单的：设置里一个输入框；不要为它建一整页）
- [ ] 改完 origin 要整个重来：tRPC / SSE / WS 三条连接全拆重建，等同冷启动
      （`docs/multi-deployment-design.md:42-51`）
- [ ] `AppConfigTests.swift` 补对应用例
- [ ] **不要顺手**把麦克风判定放宽到 `isInternal` —— `knownHosts` 是页面报上来的，
      放宽等于把麦克风授权范围交给页面决定。要改的话判据是「用户自己配过的那个 origin」

## M1 — 能力交接（页面不改）

- [ ] **A0 桥加问答通道**：`web→native {type:'req', id, method, params}` /
      `native→web window.__hermitNative.onReply(id, ok, payload)`。
      Swift 侧一张 `[String: (Bool, Any?) -> Void]` 待答表，双向 5 秒超时。
      新消息加在 `NativeBridge.swift:150-189` 的 switch；`NativeApi`
      （`native-bridge.ts:28-34`）加 `onReply`
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

**M0 第 1 条**：`AppConfig.origin` 改成 UserDefaults 里的值。

---

## 踩过的坑

- （还没有。每轮把坑写在这里，别只写进提交说明 —— 下一轮的人只读这个文件。）

---

## 轮次日志

| 轮 | 时间 | 做了什么 | 构建 |
|---|---|---|---|
| 0 | 2026-09-04 | 建这个文件，拆出 M0–M7 的清单 | 未改代码 |
