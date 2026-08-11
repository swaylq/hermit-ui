# Gateway 的 Unix / Linux 兼容性：实测报告 + 改造方案

日期：2026-07-25 · 作者：asst · 状态：**Phase A + B + doctor 已实现（2026-08-11）；C/D 未做**

> 2026-08-11 落地记录见 §9。§1–§8 是当时的实测报告与方案，保持原样。

---

## 0. 结论先说

Gateway 主体**已经接近 POSIX 干净**。全部 OS 依赖走 `tmux` / `ps` / `tail` / `zip` / `node-pty`，
没有 `fs.watch`、没有 `osascript`、没有 launchd 调用、没有 FSEvents。在 Ubuntu 24.04 上：

- 72/72 单测通过、`tsc --noEmit` 干净
- 真 gateway 冷启 40s 无崩溃（所有报错都是我故意指向死端口的 dashboard fetch）
- tmux pane 全生命周期 E2E **18/18 通过**（和 macOS 逐项一致）

**只有 1 处硬 fail**：`ps -Axo`（host-stat 的 Chrome 普查）在 procps 上直接退出 1。

真正的工作量不在 gateway 进程，而在两侧：

| 层 | 状态 | 工作量 |
|---|---|---|
| gateway 进程本体 | 1 处 fail + 3 处 macOS 默认路径 | ~1 小时，零行为变化 |
| agent 模板（scaffold 出去的东西） | 图片链路双向坏掉、Chrome 无 X server 起不来 | 半天 |
| 部署 / 运维（launchd→systemd、依赖清单） | 需要新 recipe + 预检 | 半天 |

---

## 1. 测试方法与环境

不做纸面审计，用可复现的 A/B 实测。四层：

1. **静态枚举** — grep 出所有 `spawn/spawnSync/execFile/execCapture` 调用点及其目标二进制，逐个归档（§2 表格即由此而来）
2. **命令矩阵 probe** — 37 项，用**代码里逐字相同的 argv** 跑一遍，并断言「gateway 的解析器真的能拿到数据」，不只看 exit code
3. **E2E** — 直接 import 真的 `@hermit-ui/tmux-driver` + `apps/gateway/src/pane.ts`，对一个 fake `claude` 跑完整 18 步 pane 生命周期
4. **真 gateway 冷启** — 隔离 env（`DASHBOARD_URL` 指死端口 127.0.0.1:9、独立 cwd 规避 `.env`），看 40s 内有没有 ENOENT / 崩溃 / 残留 pane

| | 基线 | 被测 |
|---|---|---|
| OS | macOS 25.4.0 (darwin, arm64) | Ubuntu 24.04.4 LTS, kernel 6.8, x86_64 |
| tmux | 3.6a | 3.4 |
| ps | BSD (macOS 自带) | procps-ng 4.0.4 |
| node | v22 | v22.22.2 |
| claude | 2.1.x（在用） | 2.1.109（装了，npm-global，凭据 2026-04-15 疑过期） |

复现脚本（本次新增，未提交）：

```
apps/gateway/scripts/compat/probe-os.mjs        # 37 项命令矩阵，两边各跑一次
apps/gateway/scripts/compat/probe-utf8.sh       # tmux UTF-8 往返（隔离 socket，不碰生产 pane）
apps/gateway/scripts/compat/e2e-driver.mts      # 真 driver + pane.ts 的 18 步 E2E
apps/gateway/scripts/compat/fake-claude-e2e.sh  # 假 claude：argv/transcript/❯/work-marker 都仿真
```

---

## 2. 实测结果矩阵

### 2.1 gateway 用到的每个外部二进制

| 调用点 | 命令 | macOS | Linux | 判定 |
|---|---|---|---|---|
| `collect/host-stat.ts:83` | `ps -Axo rss,command` | OK（591 行 / 30 chrome） | **FAIL** `must set personality to get -x option` | **P0** |
| `collect/session-snapshot.ts:69` | `ps -axo pid=,ppid=,rss=` | OK 591 行 | OK 221 行（含 pid 1，等于 `ps -eo`） | 可移植 |
| `tmux-driver:89` | `ps -ww -o command= -p <pid>` | OK | OK | 可移植 |
| `collect/host-stat.ts:43,50` | `sysctl -n vm.swapusage` / `vm_stat` | OK | ABSENT（走 `/proc` 分支） | 已处理 |
| `collect/host-stat.ts:65` | `cat /proc/meminfo` | ABSENT | OK（MemAvailable 解析成功） | 已处理 |
| `config.ts:5` | `security find-generic-password` | OK | ABSENT — `spawnSync` 返回 error 不抛，退回 `.env` | 安全（但可跳过） |
| `session-snapshot.ts:145,156` | `tail -n N` / `tail -c N` | OK | OK | 可移植 |
| `tmux-driver:543` | `tail -n +1 -F <jsonl>` | OK（历史+实时追加都收到） | OK（同上） | 可移植 |
| `file-manager.ts:183` | `zip -r -q` | OK | OK（Ubuntu 自带） | 需列依赖 |
| `file-station.ts:63` | `unzip -o -d` | OK | OK | 需列依赖 |
| `collect/usage.ts:88`、`window.ts:23` | `npx --yes ccusage …` | OK | OK（4.8s） | 可移植 |
| `machine-requests.ts:24` | `bash -lc 'claude upgrade'` | OK | OK | 可移植 |
| `control-channel.ts:146` | `node-pty` → `tmux attach` | OK | OK（prebuilt 加载+spawn 成功） | 可移植 |
| `collect/plan-usage.ts:23` | `~/.local/bin/claude` 硬编码 | OK | 存在但**应走 PATH/env** | P1 |

### 2.2 tmux 面（chat 的命门）

12 条 tmux 调用在 3.4 / 3.6a 上**逐条一致**：`new-session -d -s -c -x -y -e K=V`（`-e` 注入的
env 子进程确实看得到）、`has-session -t =NAME`、`display-message -p -t NAME.0 '#{pane_pid}'`、
`list-panes`、`capture-pane -p` / `-S -90`、`send-keys -l --` / `M-Enter` / `Enter` / `Escape`、
`set-option mouse on`、`list-sessions`、`kill-session`。

顺带确认：`display-message -t =NAME` 静默返回空串+exit 0 的坑**在 Linux 上一模一样**——
driver 用 `NAME.0` 的现有写法两边都对。

> ⚠️ 版本下限：`new-session -e` 是 tmux **3.2** 才有的。Ubuntu 22.04(3.2a)/24.04(3.4) 够；
> Debian 11(3.1c) 不够，会静默丢掉 pane env → 权限 hook 拿不到 dashboard key。要写进预检。

### 2.3 UTF-8 往返（曾经担心、实测排除）

担心点：daemon（pm2/launchd/systemd）env 里没有 `LANG`，tmux server 以非 UTF-8 locale 起来，
于是 `❯`（U+276F）检测失效、sway 打的中文被 send-keys 打烂。

用 `env -i`（完全空 env）+ 独立 tmux socket 实测，两个平台、有无 `LANG=C.UTF-8` 共 4 组：
**中文字节与 U+276F 在 send-keys 入栈和 capture-pane 出栈两个方向全部完好**。
tmux ≥2.2 无条件按 UTF-8 处理，与 locale 无关。**不是问题，不用改，别再花时间。**

### 2.4 E2E：真 driver 跑 18 步（两平台各 18/18）

`ensureSession` → `tmuxSessionExists` → `listSessions` → **`paneClaudeSessionId` 从 argv 反查 uuid**
→ `awaitTranscript` → `listTranscripts` → **`waitForReplReady`（❯ 可见）** → `readComposer=clear`
→ `watchTranscript` 补历史 → **send 一条多行中文** → `confirmSubmitted` → pane 收到的两行中文字节
完好 → watcher 收到实时追加 → 等 11s 让 transcript 过期 → `sessionActivity=idle` →
打 work-marker → `sessionActivity=working(reason=pane-marker)` → `sendInterrupt` → `kill` 后 pane 消失。

也就是说：**uuid 台账、composer 检测、working 判定、队列闸这几个最脆的机制在 Linux 上行为一致。**

### 2.5 真 gateway 冷启（Linux）

```
[gateway] starting
[login-bridge] listening ws://127.0.0.1:47615
[global-memory] ok in 1ms          ← 本机写入路径正常
[session-snapshots] ok in 8ms
[control] connecting … ECONNREFUSED … reconnecting in 1000ms → 1700ms   ← 退避正常
[usage] ok in 4799ms   [plan-usage] ok in 30215ms
```
26×chat-cancel / 19×chat-tick / 19×chat-restart / 13×machine-requests 全 ok；
所有 error 都是 dashboard fetch failed（预期）。**无 ENOENT、无 unhandled rejection、无残留 tmux session。**

host-stat 采集器在 Linux 上的真实输出（P0 的直接证据）：

```json
{ "ramTotalMb": 15993, "ramFreeMb": 11353, "swapUsedMb": 1182, "swapTotalMb": 4096,
  "loadAvg1": 0.61, "cpuCount": 4, "chromeCount": null, "chromeRssMb": null }
NULL fields: chromeCount, chromeRssMb
```

---

## 3. 问题清单（按优先级，每条带证据与修法）

### P0-1 · `ps -Axo` 在 procps 上直接失败 → Chrome 普查永久为 null

- 位置：`apps/gateway/src/collect/host-stat.ts:83`
- 证据：`ps -Axo rss,command` → exit 1 `error: must set personality to get -x option`；
  采集结果 `chromeCount/chromeRssMb` 恒为 null
- 影响：Host-health 面板看不到 Chrome 占用——而 Chrome 正是 **2026-06-30 macmini1 OOM 的元凶**。
  在 Linux 节点上这道监控直接瞎掉（静默：`chromeCensus` 内部 catch 掉）
- 修法：`-Axo` → `-axo`。已实测 `-axo` 两平台等价：macOS 591 行 / 30 个 chrome 行（与 `-Axo` 逐一相同）、
  Linux 221 行（等于 `ps -eo`，含 pid 1，含 root 进程）

```ts
// host-stat.ts:83 — `-Axo` is BSD-only (procps: "must set personality to get -x
// option"); `-axo` selects the same set on macOS AND Linux.
const out = await run('ps', ['-axo', 'rss,command']);
```

### P0-2 · config.ts 三个默认值把 Mac 路径写死

- 位置：`apps/gateway/src/config.ts:32-36`
- `AGENTS_ROOT` 默认 `/Users/mac/claudeclaw/asst/hermit-ui/agents`；
  `PROJECTS_ROOT` 默认 `/Users/mac/.claude/projects`（`.env.example` 却写着「defaults to a path
  under $HOME」——**文档与代码不符**）；`LAUNCH_AGENTS_DIR` 默认 `/Users/mac/Library/LaunchAgents`
- 影响：`.env` 少一行就静默指向不存在的路径（不是崩溃，是「什么都不做」——最难查的那种）
- 修法：`PROJECTS_ROOT` 用 `path.join(os.homedir(), '.claude', 'projects')`；
  `AGENTS_ROOT` 改成**必填**（像 `ASST_KEY` 一样缺了就 exit 1 并打印怎么修）；
  `LAUNCH_AGENTS_DIR` **全仓零引用，直接删**（已 grep 确认 apps/ packages/ 无人使用）
- 附带：`keychainKey()` 加 `process.platform === 'darwin'` 前置判断，省掉每次启动一次注定失败的 spawn

### P0-3 · 硬编码 homebrew PATH

- `apps/gateway/src/control-channel.ts:163-164`（node-pty 的 PATH 兜底）、
  `apps/gateway/ecosystem.config.cjs`（pm2 env PATH 兜底）
- 影响：Linux 上不致命（不存在的目录在 PATH 里是 no-op），但 `/usr/local/bin` 之外的
  Linux claude 安装位置（`~/.npm-global/bin`、`/snap/bin`）没被覆盖 → 新 pane `claude: command not found`
- 修法：抽到 `platform.ts` 的 `extraBinPaths()`：darwin 给 homebrew，全平台给 `~/.local/bin` + `/usr/local/bin`

### P1-1 · agent 模板的图片链路在 Linux 上**双向都坏**

这是本次最严重的发现，因为它撞的是 AGENTS.md 里的 HARD RULE。实测（Ubuntu，2400×600 PNG）：

| 场景 | 实测结果 | 后果 |
|---|---|---|
| `scripts/safe-image.sh big.png` | **exit 127**（`sips` 不存在） | 按 HARD RULE agent 必须停手报错 → **Linux 节点完全不能读图** |
| `hooks/pre-read-image.sh`（无 jq） | **exit 0** | `jq` 缺失 → `tool_name` 解析空 → 静默放行，**尺寸保护整个消失**（会重现 2026-04-19 wedge） |
| 同上（塞了 jq shim） | **exit 2**，报 `sips returned W='' H=''` | 每一张图都被拦，包括安全的小图 |

- 位置：`apps/cli/template/scripts/safe-image.sh`（全文 sips）、`scripts/hooks/pre-read-image.sh:36-37`
- `jq` 在 macOS 是 `/usr/bin/jq`（系统自带），Ubuntu **默认没有**。模板里 4 个脚本依赖它：
  `pre-read-image.sh` / `hook-web-permission.sh` / `hook-session-state.sh` / `reap-dead-sessions.sh`
  → 换成 Linux 节点，**权限网页闸和 turn-state hook 会一起静默失效**
- Linux 侧可用后端（实测都在）：`identify` + `convert`（ImageMagick 6）、Python `PIL 12.1.1`
- 修法：
  1. 抽 `scripts/lib/imagemagick-or-sips.sh`：`sips` → `magick/convert`+`identify` → `python3 -c PIL` 三级探测
  2. **彻底去掉 jq 依赖**：gateway 主机必然有 node，把 `jq -r '.x.y'` 换成 `scripts/lib/json.sh`（优先 jq、回落 `node -e`）
  3. 三个 hook 都补「后端一个都没有」的显式分支：**响亮失败 + 装包提示**，绝不静默 exit 0

### P1-2 · Chrome 在无头 Linux 上起不来

- 位置：`apps/cli/template/scripts/chrome-launcher.sh:204-214`（无 `--headless`，无 xvfb）
- 证据：`google-chrome --remote-debugging-port=… --window-size=1280,800`（模板的写法）→
  `ERROR: Missing X server or $DISPLAY` + `The platform failed to initialize. Exiting.`；
  加 `--headless=new` 后 CDP 正常应答 `Chrome/147.0.7727.101`
- 但 headless 的 UA 会变成 `HeadlessChrome/147.0.0.0`——**反爬直接看得见**，而模板整套
  stealth（`stealth-init.js` / `chrome.debugger` 真鼠标）就是为了不被看见
- 修法：Linux 分支优先 `xvfb-run -a` 起**有头** Chrome（保住 stealth），没 xvfb 再退
  `--headless=new` 并在日志里明说「已降级、指纹可被识别」。二进制探测再补
  `/opt/google/chrome/chrome`、`google-chrome-stable`、`/snap/bin/chromium`
- 附带：`chrome-reaper.ts` 的锁文件路径 `/tmp/hermit-browser-<agent>.lock` 与
  `process.kill` 探活在 Linux 上原样可用，无需改

### P1-3 · plan-usage 硬编码 claude 路径 + 未授权时白烧 30s

- 位置：`apps/gateway/src/collect/plan-usage.ts:23`（`~/.local/bin/claude`）
- 证据：Linux 冷启 `[plan-usage] ok in 30215ms`——claude 凭据过期，整个 settle 窗口耗尽后返回空
- 修法：`HERMIT_CLAUDE_BIN` env → PATH 查找 → `~/.local/bin/claude` 三级回退；
  连续 N 次拿不到数据就把探测降频（不是 Linux 专属问题，但在新节点上一定会遇到）

### P2 · 零散项

| 项 | 说明 |
|---|---|
| `scripts/fake-claude.sh` 用 `uuidgen` | Ubuntu 默认无（属 `uuid-runtime`）→ 测试脚本自己坏。换 `python3 -c uuid4` 或 node |
| `zip` / `unzip` | Ubuntu 有，最小化镜像/容器常没有 → 进依赖清单 + 预检 |
| tmux ≥ 3.2 | `new-session -e` 的下限，见 §2.2 |
| 大小写敏感文件系统 | 采集器按 `CLAUDE.md` / `IDENTITY.md` 精确大小写读；APFS 不敏感、ext4 敏感 → **迁移存量 agent 时必须先扫一遍文件名大小写**，否则 agent 在 Linux 上直接不被识别（`collect/agents.ts:192` 找不到 `CLAUDE.md` 就返回 null） |
| `image-relay.ts` | 只是注释提到 sips，代码本身不调用（信任 dashboard 写好的 `.safe.*`）——无需改 |
| dashboard `/api/upload` | 已经 `sips` → `identify` 双后端，且本就跑在 Linux VPS 上——**已兼容，别动** |

---

## 4. 改造方案

### 4.1 三条设计原则

1. **优先选两平台通吃的命令，而不是加 `if (platform)` 分支。**
   `-Axo`→`-axo` 是范式：一处改动、零分支、macOS 行为逐字不变。分支只留给真的没有共同解的地方（内存统计）。
2. **平台差异集中在一个模块，别撒在 15 个文件里。**
   新增 `apps/gateway/src/platform.ts` 作为唯一出口；配一条 CI grep 断言把差异挡在这个文件里。
3. **能力探测不要静默退化。**
   本次三个最坑的发现（chromeCount 恒 null、hook 静默放行、plan-usage 白烧 30s）都是「悄悄不工作」。
   新代码一律：**要么能干活，要么响亮报错并说明装什么包**。

### 4.2 Phase A — gateway 本体（~1 小时，零行为变化，可独立合入）

1. `host-stat.ts:83` `-Axo` → `-axo`（**P0-1**）
2. `config.ts`：`PROJECTS_ROOT` 走 `os.homedir()`；`AGENTS_ROOT` 改必填并 fail fast；删 `LAUNCH_AGENTS_DIR`；`keychainKey()` 加 darwin 判断（**P0-2**）
3. 新建 `platform.ts`：`isDarwin/isLinux`、`PS_ALL_ARGS`、`extraBinPaths()`、`defaultClaudeBin()`
4. `control-channel.ts` + `ecosystem.config.cjs` 的 PATH 兜底改走 `extraBinPaths()`（**P0-3**）
5. `plan-usage.ts` claude 路径三级回退（**P1-3**）
6. 收编本次 4 个 probe 脚本进 `apps/gateway/scripts/compat/`，加 `npm run compat`

Phase A 之后：**gateway 进程本身在 Linux 上功能完整**（chat / cron / 终端 / 文件 / 知识库 / secrets 全走已验证的路径）。

### 4.3 Phase B — agent 模板跨平台（~半天）

1. `scripts/lib/platform.sh`：`os_kind()`、`have <bin>`、`die_missing <bin> <apt包> <brew包>`
2. `scripts/lib/imagemagick-or-sips.sh`：`image_dims` / `image_resize` 双后端（+PIL 兜底），`safe-image.sh` 改成薄封装（**P1-1**）
3. `scripts/lib/json.sh`：`json_get <path>`，优先 jq、回落 `node -e`；4 个用 jq 的脚本全部改走它（**P1-1**）
4. 三个 hook 补「无后端」显式分支：exit 2 + 装包提示，禁止静默 exit 0
5. `chrome-launcher.sh`：Linux 走 `xvfb-run -a`，无 xvfb 降级 `--headless=new` 且日志明示（**P1-2**）
6. `fake-claude.sh` 去掉 `uuidgen`
7. 模板 `AGENTS.md` 的 macOS 措辞（sips / Library / launchctl）改成平台中立

> 注意：`apps/cli/template` 是 `create-hermit-agent` 与 dashboard「从模板新建」的共同源，
> 改完**存量 agent 不会自动更新**——需要一次幂等 rollout 脚本（参照 2026-06-21 template rollout 的做法）。

### 4.4 Phase C — 部署与运维（~半天）

| macOS 现状 | Linux 对应 |
|---|---|
| pm2 + `ai.claudeclaw.pm2-resurrect` LaunchAgent | `pm2 startup systemd` 生成 unit + `pm2 save`（用户级要 `loginctl enable-linger $USER`，否则退出 SSH 就被杀） |
| `ai.claudeclaw.bootstrap-all` LaunchAgent 拉 tmux | 同一脚本挂 `systemd --user` unit（`After=network-online.target`） |
| 凭据：Keychain + `age` identity 文件 | **无 Keychain** → `secret init` 走 600 权限的 identity 文件（CLI 已支持双源回退）；`age` 需 `apt install age` |
| per-agent 定时任务 | 不变：一律 cron skill，**不要**碰 systemd timer |

新增一条 **`npm run doctor`**（gateway 内，跨平台）——这是新节点上线性价比最高的东西，一次输出：
tmux 版本 ≥3.2 / `ps` 方言 / `claude` 位置与版本 / `zip`+`unzip` / 图片后端 / `jq`-or-node /
`age`+`secret` / Chrome+xvfb / `~/.claude/projects` 可写 / `AGENTS_ROOT` 存在 / DASHBOARD 可达。
缺什么就直接给 `apt install …` 的原句。

依赖清单（Ubuntu 24.04 一行装齐）：

```
sudo apt install -y tmux zip unzip imagemagick age xvfb jq uuid-runtime
# 另需：node ≥20、pm2、Claude Code（native installer 装到 ~/.local/bin）
```

### 4.5 Phase D — 防回归

1. **CI**（repo 已公开在 GitHub，免费 runner）：`ubuntu-latest` 上跑 `npm test` + `npm run compat`；
   macOS runner 跑同一套。这样「谁再写一个 BSD-only flag」当场红
2. **grep 断言**（作为一条测试）：`apps/gateway/src` 内不允许出现 `/Users/`、`/opt/homebrew`、
   `sips`、`vm_stat`、`launchctl`、`security ` 字面量，`platform.ts` 与注释除外
3. `.env.example` 与 `config.ts` 对齐（本次已发现两者不一致）

---

## 5. 明确不做

- **Windows**：不在范围。tmux 模型不成立，另开话题
- **重写 tmux 模型 / 容器化**：Docker 打包看着诱人，但 chat 依赖「长活 tmux + 交互式 claude 计费桶」，
  容器化要连带解决 auth、pty、宿主 Chrome，收益不明。先让裸 Linux 主机等价，再谈
- **dashboard**：本来就跑在 Linux 上、且已是 OS 无关，除 `.env.example` 一致性外不动
- **\*BSD**：`platform.ts` 抽出来后只差一个 `sysctl hw.physmem` 分支，等真有需求再加

---

## 6. 验证计划（改完怎么算过）

1. `probe-os.mjs` 在 Linux 从 36/37 → **37/37**，macOS 保持 37/37（防回归）
2. `e2e-driver.mts` 两平台各 **18/18**
3. `npm test` + `tsc --noEmit` 两平台干净
4. Linux 上 `collectHostStat()` 的 `chromeCount/chromeRssMb` **不再是 null**（起一个带 CDP 的 Chrome 后核对）
5. 模板矩阵：`safe-image.sh` 对 2400px 图产出 sidecar；hook 对超限图 exit 2、对小图 exit 0、
   **无后端时 exit 2 且有装包提示**；`chrome-launcher.sh start` 在无 DISPLAY 主机上真能起来并应答 CDP
6. **端到端真活**（唯一尚未验证的一环）：在一台 Linux 上装 Claude Code 并**完成 auth**，
   用独立 machine key 接入 dashboard，跑一个真 agent：新建会话 → 发中文消息 → 收到回复 →
   `/compact` → cron 触发一次 → 网页终端 attach → 上传下载文件。
   这一环卡在 auth 而非代码：**每台机器要自己的 Claude Code 登录**（参见
   `feedback_openclaw_auth_propagate` 的教训：auth 不会自动 propagate）

---

## 7. 风险与未知

| 风险 | 说明 | 缓解 |
|---|---|---|
| **claude TUI 在 Linux 的渲染差异** | E2E 用的是 fake claude；`❯` 检测、resume 选择器、`esc to interrupt` 的真实渲染没在 Linux 上验过（VPS 凭据过期） | Phase A 之后先在 Linux 上手动跑一次真 claude pane，专看 `readComposer` / `acceptResumePromptAsFull` |
| chat-runner 的冷启竞态 | `robustSubmit` / uuid 漂移自愈依赖时序，Linux 上 fs 与调度特性不同 | 新节点先只跑 1-2 个 agent 观察，别一次迁完 |
| 存量 agent 迁移 | 文件名大小写、绝对路径（`/Users/mac/...` 写在 agent 自己的 md 里）、`browser/user-data` 不可跨平台复用 | 写一个迁移预检脚本：扫大小写冲突 + grep `/Users/` + 不搬 `browser/` |
| pm2 用户级 unit 被登出杀掉 | Linux 特有坑 | `loginctl enable-linger`，并进 doctor 检查项 |
| Chrome 指纹（headless 降级） | 反爬识别 | 优先 xvfb；降级时日志明示 |

---

## 8. 建议的推进顺序

**A（gateway 本体）→ 在 Linux 跑一次真 claude 手验 → C（部署+doctor）→ B（模板）→ D（CI）**

把 B 放在 C 之后，是因为模板改动要在**真节点**上验（图片/Chrome 都得有真环境），
而 A 加上 doctor 就足够先把一台 Linux 机器接进舰队跑「不读图、不开浏览器」的 agent——
先拿到可用节点，再补齐能力。

---

## 9. 落地记录（2026-08-11）

做了 **Phase A + Phase B + doctor**。C（部署运维）和 D（CI）没做。

### 9.1 Phase A — gateway 本体

| 计划项 | 落地 | 备注 |
|---|---|---|
| P0-1 `-Axo` → `-axo` | ✅ `collect/host-stat.ts` 改走 `psAll()` | 常量收在 platform.ts，字面量不再散落 |
| P0-2 config 三个 Mac 默认值 | ✅ | `PROJECTS_ROOT` 走 `os.homedir()`；`AGENTS_ROOT` 必填；`LAUNCH_AGENTS_DIR` 删除（全仓零引用）；`keychainKey()` 加 darwin 前置判断 |
| P0-3 硬编码 homebrew PATH | ✅ `control-channel.ts` 走 `pathWith()`；`ecosystem.config.cjs` 手抄同一份列表（CJS 进不来 TS） | Linux 补了 `~/.npm-global/bin`、`/snap/bin` |
| P1-3 plan-usage claude 路径 | ✅ `findClaudeBin()` 三级回退，每次调用重新解析 | 装了 claude 不用重启 gateway |
| 新增 `platform.ts` | ✅ | `isDarwin/isLinux`、`psAll()`、`extraBinPaths()`、`pathWith()`、`findClaudeBin()` |
| probe 脚本收编 | ❌ 没做 | 见 §9.4 |

**方案没预料到的一处**：`AGENTS_ROOT` 改必填后，**一半测试挂了**。
原因是 `config.ts` 在**模块作用域**里 `process.exit(1)`，而半数测试会传递性 import 到它。
（以前没暴露：ASST_KEY 那条同样的 exit 被 macOS keychain 兜住了，Linux 上其实早就会挂。）

→ 校验抽成 `assertRequiredConfig()`，由 `index.ts` 在启动时调用。
生产行为一字不变（同样的消息、同样的 exit 1、同样在干活之前，pm2 退避照旧），
但 import 不再能杀进程。`src/config.test.ts` 把这条钉死。

### 9.2 Phase B — agent 模板

新增 `apps/cli/template/scripts/lib/`：

- `platform.sh` — `os_kind` / `have` / `install_hint` / `die_missing`，并给 daemon 起的瘦 PATH 补路径
- `image.sh` — `image_dims` / `image_format` / `image_to_png`，三级后端 sips → ImageMagick → PIL
- `json.sh` — `json_get` / `json_array_has` / `json_quote` / `json_merge`，jq 优先、node 兜底
- `lib.test.sh` — **每个后端都跑一遍**（把首选后端从 `have` 里藏掉再跑第二遍）。本机 50/50

改造：`safe-image.sh` 变成薄封装；4 个 jq 使用者全部改走 `json.sh`；
`chrome-launcher.sh` 在无 DISPLAY 的 Linux 上优先 `xvfb-run -a`（保住 headful，
stealth 不失效），没有 xvfb 才降级 `--headless=new` **并在日志里明说 UA 会暴露**。

**三个 hook 的失败方向是分开决定的，不是抄同一个默认值**：

| hook | 没有 parser 时 | 为什么 |
|---|---|---|
| `hooks/pre-read-image.sh` | **exit 2 挡住** | 验证不了尺寸就不能放行，超大图会 wedge 会话 |
| `hook-web-permission.sh` | **exit 0 放行 + 大声告警** | 这里 exit 2 是「拒绝」，会挡掉 agent 所有工具 |
| `hook-session-state.sh` | **exit 0 不动文件** | 只是上报状态；状态陈旧不好，但状态被写坏更糟 |

**写这段时踩到的真 bug**（值得记下来，因为它就是本次要消灭的那种失败）：
第一版写了个 `json_get_or_die`，里面 `exit 2`。但调用点都是 `x=$(json_get_or_die …)` ——
**命令替换里的 `exit` 只结束子 shell**。实测结果：hook 打印了
「refusing to continue — a hook that cannot parse its input must not pass」，
然后 **exit 0 放行**。一模一样的静默通过。
→ 该 helper 整个删掉，改成在父 shell 里先 `have_json_parser ||` 一次。
lib/json.sh 里留了注释说明为什么不该再把它加回来。

**另一处**：`"${arr[@]}"` 在空数组 + `set -u` 下，macOS 自带的 bash 3.2 会报
unbound variable。按显然的写法写，chrome-launcher 会在**它本来好好的 Mac 上**起不来。
改用 `${arr[@]+"${arr[@]}"}`。所有改过的脚本都过了 `/bin/bash -n`。

### 9.3 doctor

`apps/gateway/scripts/doctor.mjs`（`npm run doctor`）：tmux ≥3.2（并解释为什么是 3.2）、
`ps -axo`、node、claude（按 gateway 自己的解析顺序找）、codex + 是否登录、
`.env` 三个必填项、AGENTS_ROOT 存在与 agent 数、**Linux 上扫文件名大小写**
（ext4 敏感、APFS 不敏感，是存量 agent 迁过去后「消失」的最可能原因）、
zip/unzip、图片后端、jq-or-node、chrome + xvfb、secret + age。

缺什么就给**本平台**的安装原句，末尾给 Ubuntu 一行装齐。有 ✘ 就 exit 1，可以拿来卡部署。

### 9.4 存量 agent

模板改了，**存量 agent 不会自动更新**。`scripts/rollout-portable-scripts.sh` 幂等地推：
只替换 agent 已经有的文件（lib/ 除外，那是新增的），首次保留 `.pre-portable` 备份，
`--dry` 先看。本机 dry-run：39 个 agent、365 个文件、9 个非 agent 目录正确跳过。

**尚未执行**——它会改 39 个真实 workspace，交给人决定什么时候推。

### 9.5 没做的

- **Phase C（部署运维）**：systemd/pm2 startup、`loginctl enable-linger`、迁移预检脚本
- **Phase D（CI）**：GitHub Actions 双平台、grep 断言（禁止 `/Users/`、`sips`、`-Axo` 等字面量再进 `apps/gateway/src`）
- **§1–§2 的 probe 脚本**没有收编进仓库（`npm run compat` 不存在）；doctor 覆盖了其中最有用的部分
- **§6.6 端到端真活**：仍未做。卡在每台机器要自己 `claude login`，不是代码问题
