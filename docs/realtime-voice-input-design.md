# 实时语音输入（豆包式）— 设计

**Goal:** 把现在「长按录完 → 松手 → 等 1.5s → 整段文字掉进输入框」的语音输入，换成**边说边出字**：说话的同时文字实时上屏，每说完一句（VAD 断句）后台悄悄跑一遍 AI 纠错，把那一句就地替换成准确版本 —— 用户全程不等待，看到的是文字自己长出来、自己改对。

**参照：** 豆包输入法（Seed-ASR / Seed-ASR2.0）。它的体感来自四件事，本设计逐条对齐：

| 豆包做的事 | 我们怎么做 |
|---|---|
| 说话同时上屏，首字延迟 200–300ms | 流式 ASR WebSocket，partial 结果直接进 preedit 条 |
| 「转换过程全程可见」——先识别成一个字，然后自己改成另一个 | partial 本来就会自我改写（实测见下）；不做防抖，如实呈现 |
| 智能标点、语气词自动过滤 | ASR 侧开 `punctuation_prediction_enabled`；语气词交给逐句纠错 |
| 上下文语义消歧、专名记忆 | 逐句纠错带对话上下文（已有 `transcribe-context.ts`）+ 热词表 |

**核心差异（必须承认）：** 豆包是**一个** LLM-ASR 模型端到端做完识别 + 纠错；我们是**两段式**（流式 ASR + 逐句 LLM 纠错）。所以我们的「改对」是可见的二次替换，不是模型内部的实时自纠。设计的全部功夫在于**把这次替换藏在用户说下一句的时间里**，让它不成为等待。

---

## 现状

`components/chat/voice-mic.tsx` → `lib/voice-capture.ts` 攒满整段 WAV → `POST /api/transcribe` → DashScope `qwen3-asr-flash`（整段）→ `qwen-flash` 定稿 → 一次性 `onTranscript(text)`。

问题只有一个但是致命的：**所有反馈都在松手之后**。说 30 秒就得盯着一个转圈的胶囊等 2 秒，且说错了要全删重来。

---

## 协议探测（实测，2026-08-20）

用 `say -v Tingting` 合成的中文 clip 打真实端点，`DASHSCOPE_API_KEY` 就是现在 `/api/transcribe` 用的那把。

### fun-asr-realtime（推荐默认）

`wss://dashscope.aliyuncs.com/api-ws/v1/inference` —— **公网 host 直接可用，不需要 workspace 专属域名**。run-task / 二进制音频 / finish-task 三段式。

```
[+  256ms] open
[+  360ms] task-started
[+  609ms] result {"end":false,"text":""}
[+  749ms] result {"end":false,"text":"发"}
[+ 1164ms] result {"end":false,"text":"发 red hot"}
[+ 2203ms] result {"end":false,"text":"发 red hote的隧道"}
[+ 3172ms] result {"end":false,"text":"把Red Hole的隧道重启"}          ← 自我改写，全程可见
[+ 3782ms] result {"end":false,"text":"把Red Hole的隧道重启一下"}
[+ 5755ms] result {"end":false,"text":"把Red Hole的隧道重启一下，然后帮我看看日志有没"}
[+ 6841ms] result {"end":true,"text":"把Red Hole的隧道重启一下，然后帮我看看日志有没有报错。","b":160,"e":5720}
```

- **首字 ~250ms**（task-started 之后）。partial 每 400–1000ms 一帧，一直跟着嘴走。
- **`"发" → "把Red Hole"` 这个自我改写正是豆包那个「你会看到它先识别成一个字，然后自己改成另一个」**。不需要我们做任何事，如实渲染就有。
- 标点是模型加的，不是说出来的。

**中途断句实测**（两句之间插 1.2s 真静音）：

```
[+ 5113ms] result {"end":true,"text":"帮我把japan dev上的pady重启一下。","b":120,"e":3120}
[+ 8784ms] result {"end":true,"text":"然后检查一下证书还有多少天过期。","b":4350,"e":7750}
```

第一句在 **+5113ms 就 `sentence_end:true` 了，而音频还在继续推**。这就是「间隔的句子做 AI 纠错」的触发点 —— 第一句进纠错的时候用户正在说第二句，那 ~0.5s 是白赚的。

### qwen3-asr-flash-realtime（备选）

`wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime`，OpenAI-realtime 风格协议（`session.update` / `input_audio_buffer.append` / server VAD）。

- 逐字 delta（`conversation.item.input_audio_transcription.text` 带 `stash`），打字机感更强；`.completed` 给整句终稿。
- 自带 `turn_detection: server_vad`，`silence_duration_ms` 可调，会自动切成多个 item。
- **坑：`language: null` 会 400**（`Language code 'null' is not recognized`），要么给具体语言要么整个字段不给。
- **`input_audio_transcription.context` 传进去被接受但无效** —— 同一 clip 带不带 context 输出完全一致（`把 Red Hollow 的隧道重启一下。`）。这一条跟 `/api/transcribe` 里对 `asr_options.context` 的既有注释是一致的结论。

### 热词表（vocabulary）

`POST https://dashscope.aliyuncs.com/api/v1/services/audio/asr/customization`，`model: "speech-biasing"`，`action: "create_vocabulary"` + `target_model: "fun-asr-realtime"` + `prefix` + `vocabulary:[{text,weight,lang}]` → 返回 `vocabulary_id`，塞进 run-task 的 `parameters.vocabulary_id`。

**创建/删除接口实测通**。但在 `rathole` 这个词上**没测出效果**（带不带词表都是 `Red Hole`）—— 合成 TTS 念英文专名的发音本来就不像人念，这个结论不可信，需要真人语音复测再决定要不要上。

### 成本

`fun-asr-realtime` 按音频秒计费 **0.00033 元/秒 ≈ 1.19 元/小时**，输出不计费，开通 90 天内 36000 秒免费额度。逐句纠错走 `qwen-flash`，一句几十 token。**每天口述半小时 ≈ 0.6 元。** 不是约束。

### 一句话结论

**三个词全错**（`rathole→Red Hole`、`caddy→pady`、`japan-dev→japan dev`）。流式 ASR 给的是**草稿**，不是终稿。逐句 LLM 纠错不是锦上添花，是这套东西能不能用的前提 —— 而它恰好也是「精准识别用户的原句」这个诉求的落点。

---

## 架构

```
[浏览器]
  VoiceMic 点一下 ──> DictationDock.toggle()
       │
       ├─ voice-capture.startStreaming()  麦克风 → 16k mono PCM16，每 ~85ms 一包
       │                                   + RMS 静音门控 + 「上一句之后」的兜底缓冲
       └─ asr-socket  WSS /api/asr/<sessionId>?style=…
                      auth: Sec-WebSocket-Protocol: hermit-key.<token>
                      上行二进制音频，下行 JSON
                          ▲
                          │
[dashboard server.ts]  upgrade 第三个分支 → src/server/asr-ws.ts
       │  鉴权 resolveMachineByKey（machine key only）+ session 归属
       │  loadContext(prisma, sessionId) → 最近几句对话
       ▼
[src/server/asr-stream.ts]
       ├─ DashScope  wss://dashscope.aliyuncs.com/api-ws/v1/inference  fun-asr-realtime
       │     懒开（首帧才开任务）· 静音 20s 自动关 · 4 分钟在句边界回收重开
       └─ sentence_end → fork 逐句纠错 qwen-flash（temperature 0）
                          + 对话上下文 + 本次口述的前两句作参考
                          → acceptPolish / inventedTerm 两道兜底
```

**为什么代理而不是浏览器直连：** `DASHSCOPE_API_KEY` 不能进浏览器，DashScope 也没有 OpenAI Realtime 那种临时 token。

**为什么挂在 `server.ts` 的 upgrade 上：** 那里已经有 `/api/gateway/ws` 和 `/api/term/<sessionId>` 两个先例，第三个分支是照抄；`hermit-key.<token>` 子协议鉴权、Caddy WS 反代和 idle timeout 全都是趟平过的（`docs/caddy-ws-timeout-patch.md`）。

**为什么 WS 逻辑不写在 `server.ts` 里：** `server.ts` 是个启动 Next 并绑端口的脚本，**没法被 import**，写在里面的东西就没法测。所以真正的实现全在 `src/server/asr-ws.ts`，依赖（连 ASR stream 工厂）都是注入的 —— 测试可以拿真 socket 打整条链路，远端换成假的 ASR，全程不联网（`src/server/asr-ws.test.ts`）。

**一个已知限制：** 和终端一样，`/api/asr` **只认 machine key**。scoped agent 分享 token 走 `resolveMachineByKey` 返回 null → 401，共享 agent 的用户继续用长按整段模式。`server.ts` 跑在 tsx 下，`@/` 别名**不解析**（实测：`Cannot find module '@/generated/prisma/client'`），所以 `resolveKey` / `auth.ts` 这条链根本 import 不进来 —— 这也是 `transcribe-context.ts` 改成由调用方传 Prisma client 的原因。

---

## 交互：三层文本

| 层 | 内容 | 在哪 | 样式 |
|---|---|---|---|
| **partial** | 当前 partial，每帧整体替换，会自我改写 | 输入框**上方**的听写条 | 暗一档 + 斜体，长了只显示尾部 |
| **tail（已断句）** | `sentence_end` 的句子，立刻落进草稿 | 输入框内 | 正常 |
| **polished** | 纠错结果就地替换 | 输入框内，同一位置 | 正常 |

**partial 不进 textarea：** 它每 400ms 整体重写一次，写进去要跟光标抢所有权，而且 `<textarea>` 没法给子串上色 —— 没法表达「这几个字还会变」。放在上方的条里 = IME 预编辑串的老办法：**不稳的字不进文档**。

**替换不做偏移算术：** 纠错是并发的、会乱序回来，所以 `asr-socket` 按 `segId` 更新它的 segment 数组，然后把**整条 tail 重新拼出来**交给 composer。composer 只维护一个不变式 `draft === base + tail`；不成立就说明用户中途手打了字 —— **用户的字赢**，把当前草稿收作新 base，tail 从后面重新长。全部逻辑在 `lib/dictation-text.ts`（纯函数，`foldTail` 幂等，12 个用例）。

---

## 交互：手势

| 操作 | 现在 |
|---|---|
| **点一下** | 开始 / 结束实时听写（立即响应，不等双击窗口） |
| 长按 | 按住说话，松手整段转写（不变） |
| 双击 | 打开风格设置。第一下开的那次听写会被撤销 —— 300ms 内说不出话，没有损失 |
| 右 Option | 桌面按住说话（不变；听写进行中被禁用） |
| 拖动 | 移动 FAB（不变） |

**听写期间 FAB 隐藏（不是卸载）。** FAB 可拖、听写条不可拖，两者必然会在某个位置重叠 —— 默认位置就重叠了，FAB 正好压住条上的 ✓（实测截图）。一次只留一个控制面：听写期间条就是全部，它有 ✓ 和 ✕。**卸载不行**：VoiceMic 的 cleanup 会 `releaseWarmMic()`，那会在听写中途把麦克风关掉。

**自动收尾：** 连续静音 30s 结束；单次听写 20 分钟上限；socket 侧 30 分钟硬上限。

**静音门控：** 客户端 RMS 低于阈值持续 1.5s 就停止上行（DashScope 按音频秒计费）。1.5s 比服务端 800ms 的断句静音长，所以在飞的那句**总是先收尾、再关闸**。

---

## 纠错这一步

用户要的是「**精准识别用户的原句**」，所以这一步是**纠错**不是改写：realtime 默认 `minimal`（保留原话），`rewrite` 仍可选；整段模式的默认不动。

复用 `transcribe-polish.ts` 已有的一切 —— fence、no-answer 铁律、`acceptPolish` 长度兜底。新增三样：

1. **`<preceding>` fence** —— 本次口述里这句之前已整理好的两句，只作参考（判断承接、列举到第几条）。
2. **`SENTENCE_SYSTEM_SUFFIX`** —— 逐句模式的附加铁律，核心是「**这句可能本来就不完整，保持它不完整**」。递半句话给 chat 模型，它会想替你说完；说完的那部分是没人说过的话。
3. **`inventedTerm()` 兜底** —— 见下。

### 为什么需要 inventedTerm

流式 ASR 不会把英文词听成中文，它把英文词听成**另一个英文词**：caddy→`pady`、rathole→`Red Hole`。还原这些正是逐句纠错的主要价值，prompt 也这么要求。但「猜猜这词到底是什么」离「编一个说得通的词」只有一步之遥 —— 同一段音频实测，`pady` 回来过 `Caddy`（对，context 里写着）、回来过 `pady`（没改，可以接受），也回来过一次 **`JUPYTER`**（音频里没有、对话里也没有）。

猜错比不猜更糟，所以这个猜是**结构性**地限死的，不是靠把 prompt 写得更客气：一个英文词只有在**有据可查**（原转写里有，或 context 里有）时才允许被替换掉。

| 情况 | 判定 |
|---|---|
| `pady` → `Caddy`（context 里有 Caddy） | 放行 |
| `japandev` → `japan-dev`（同样的字母，只是重排标点） | 放行 |
| 「道克」→ `Docker`（从中文变出来的，没挤掉任何英文词） | 放行 |
| `pady` → `JUPYTER`（无据，且原文的 `pady` 从输出里消失了） | **拒绝，保留原句** |

整段模式**不用**这道兜底：它走另一个 ASR、`rewrite` 风格本来就该更自由，也从没出现过这种错。保真是实时这条路的本职。

---

## 实测

### 端到端（打真实运行的 dashboard，真实 DB，真实 DashScope）

```
[+   11ms] open
[+  255ms] ready
[+  549ms] partial "帮我"
[+ 3239ms] partial "帮我把JAPAN DEV上的PADDY穿一下"
[+ 4427ms] FINAL  #1 "帮我把japandev上的pady重启一下。"
[+ 4938ms] POLISH #1 "帮我把 japan-dev 上的 caddy 重启一下。"   ← 511ms，落在第二句还在说的时候
[+ 4638ms] partial "Yeah"                                      ← 第二句已经在出字了
[+ 8222ms] FINAL  #2 "然后检查一下证书还有多少天过期。"
[+ 8476ms] POLISH #2 + done
```

坏 key → **401**；不属于本机的 session → **404**。

### 纠错可靠性（同一段合成语音，6 次）

- `japandev` → `japan-dev`：**6/6**
- `pady` / `paddy` / `padi` → `caddy`：**5/6**，剩下 1 次原样保留（安全的失败）
- 无一次编造

`temperature: 0`（不是整段模式的 0.2）—— 这是纠错不是创作，答案就写在 context 里。0.2 下同一段音频 `Red Hole → rathole` 只有 2/3。

### 浏览器（真 Chromium + `--use-file-for-fake-audio-capture`）

点一下麦克风 → 听写条出现 → 第一句纠错完成后落进输入框，**第二句还在条里出字** → ✓ 收尾，条消失，草稿保留。无 console 报错。

### 成本

`fun-asr-realtime` **0.00033 元/秒 ≈ 1.19 元/小时**，输出不计费。逐句纠错一句几十 token。每天口述半小时 ≈ 0.6 元。

---

## 文件

| 文件 | |
|---|---|
| `src/server/asr-stream.ts` | **新** DashScope 流式会话：懒开/回收/重连上限、`sentence_end` fork 逐句纠错 |
| `src/server/asr-ws.ts` | **新** `/api/asr/<sessionId>` 端点：鉴权、路由、帧转发、依赖全注入 |
| `src/server/asr-ws.test.ts` | **新** 真 socket + 假 ASR，8 个用例（401/404/未配置/收发/stop 之后的音频/style/context） |
| `src/server/dashscope.ts` | **新** 抽出的 DashScope chat 客户端（整段路由与实时路由共用） |
| `src/lib/asr-socket.ts` | **新** 浏览器 WS 客户端 + segment 状态机 |
| `src/lib/dictation-text.ts` (+ `.test.ts`) | **新** `joinSegments` / `foldTail`，12 个用例 |
| `src/lib/voice-style.ts` | **新** 风格常量，麦克风与听写台共用 |
| `src/components/chat/dictation-bar.tsx` | **新** 预编辑条 |
| `src/components/chat/dictation-dock.tsx` | **新** 听写台：麦克风流 + socket + 兜底，state 关在这里，SessionPane 只收到 start/stop |
| `src/lib/voice-capture.ts` | `startStreaming()` + 有状态重采样 + 静音门控 + 兜底缓冲（`startRecording` 不动） |
| `src/components/chat/voice-mic.tsx` | 点一下 = 听写；听写中禁用长按与 PTT |
| `src/components/chat/composer.tsx` | `beginDictation` / `setDictationTail` / `endDictation` |
| `src/app/chat/page.tsx` | 挂听写台、隐藏 FAB |
| `src/server/transcribe-polish.ts` | `<preceding>` fence、`SENTENCE_SYSTEM_SUFFIX`、`inventedTerm` |
| `src/server/transcribe-context.ts` | Prisma client 改为传入（tsx 不解析 `@/`） |
| `server.ts` | 第三个 upgrade 分支，委派给 `asr-ws.ts` |
| `src/app/api/transcribe/route.ts` | 只改用共享 dashscope 客户端；行为不变，仍是兜底 |

**Env：** `DASHSCOPE_API_KEY`（没有就不进入听写态，只留长按）、`DASHSCOPE_REALTIME_ASR_MODEL`（默认 `fun-asr-realtime`）、`DASHSCOPE_REALTIME_WS_URL`、`DASHSCOPE_POLISH_MODEL`（默认 `qwen-flash`）、`DASHSCOPE_ASR_VOCABULARY_ID`（可选热词表）。

---

## 回退

流式比整段脆（WS 断、限流、Caddy 掐连接），**回退是无损的**：

- 采集层一直留着**上一句断句之后**的音频（每次 `final` 清空，通常几秒）。socket 挂了 → 已确认的句子留在草稿里，剩下这几秒 POST 给现有 `/api/transcribe` 补上。一个字都不丢。
- 逐句纠错失败 / 被两道兜底拒绝 → 保留 ASR 原文。
- 没有 `DASHSCOPE_API_KEY` → 服务端明说 `not configured`，客户端不重试，只留长按。
- scoped agent 分享 token → 401，同上。

---

## 还没做

- **热词表（`vocabulary_id`）**：创建/删除接口实测通，但在合成语音上测不出效果（TTS 念英文专名本来就不像人念），**需要真人语音复测**再决定要不要开。开关已经留好（`DASHSCOPE_ASR_VOCABULARY_ID`），词表内容可以从本机 agent 名 / 仓库名 / 主机别名 / skill 名自动生成。
- **上线后量一次真实首字延迟**：这里所有数字都是本机 → DashScope 北京。生产是浏览器 →（日本 VPS）→ 北京，多绕一跳。整段路由走的是同一条路且可用，但流式对 RTT 敏感得多。
- **`_next/webpack-hmr` 在 dev 下 404**（`server.ts` 的 upgrade 分支不认它）——先于本次改动就存在，dev-only，没碰。
