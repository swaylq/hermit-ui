# worktree skill — 同一个 agent 多会话改同一个项目

**问题.** dashboard 的每个会话都是同一个 agent 目录下的一个 tmux pane，跑着各自的 claude。同一时刻这台机器上 `finance-agent` 有 6 个活会话、`asst` 有 5 个（2026-08-05 实测）。它们共享目录里的每一个 git repo：一个会话 `git switch` 走一条分支，另一个会话的工作区就在它眼皮底下变了；两边同时改文件则互相覆盖。已经吃过的亏：兄弟会话把我的 worktree 路径 `hermit-ui-wt2` 整个 `rm -rf` 重建而我这边零报错；兄弟会话把分支切走导致提交落到错误的分支上。

**目标.** 同一个 agent 的多个会话改同一个 repo 时，各自在独立的 git worktree 里干活，互不冲突，且**谁都不需要切换分支**。

**非目标.** 跨 agent 的协调（不同 agent 目录本来就不共享 repo）；submodule / git-LFS 仓库；非 git 项目。

---

## 1. 判定：要不要隔离

规则一条：

> 动某个 git repo 之前，如果这个 agent 还有**别的活会话**，就进自己的 worktree。

**不需要登记表、不需要锁、没有共享状态。** 先到的会话留在主 checkout（它当时没有兄弟，规则没触发），后来的各自进 worktree。两个会话同时开、互相看见、双双进 worktree 也正确——主 checkout 空着，比任何一方占着都安全。没有状态就没有可损坏的状态，也没有需要清理的陈旧条目。

**活性判定不能依赖 tmux**（2026-08-21 更正，见文末）。会话名 `hermit-<会话 id 后 12 位>` 两个底座都成立，判定分两步：

```
# 我是谁：两个底座都往 claude 进程的环境里塞了 HERMIT_SESSION_ID
hermit-$(短id "$HERMIT_SESSION_ID")            # tmux 的 #S 只作兜底

# 还有谁活着：网关起的每个 claude，argv 的 --mcp-config 里都带着 HERMIT_SESSION_ID
ps -axww -o pid= -o args=                      # pid → 会话 id
lsof -a -d cwd -p <pids> -Fpn                  # pid → cwd（Linux 走 /proc/<pid>/cwd）
```

与自己同一个 agent 目录、且不是自己的，就是兄弟会话。claude 进程不 chdir，所以**进程的 cwd 稳定等于 agent 目录**——这条在 pane 时代表现为 `pane_current_path`，换底座后依然成立，所以判定换的只是读法。一次 `ps` 加一次 `lsof`，没有 per-process 扇出，因为它挂在每次 SessionStart 上。

## 2. 路径与分支

| | 约定 |
|---|---|
| worktree | `~/.hermit/worktrees/<repo>/<会话id后12位>` |
| 分支 | `wt/<会话id后12位>` |

按**会话 id** 派生，不用编号。编号路径（`…-wt1`、`…-wt2`）是共享命名空间，兄弟会话会认为它是自己的而删掉重建——这正是之前那次事故。放 repo 之外则绕开另一个陷阱：hermit-ui 的 `.gitignore` 并没有 `.worktrees`，repo 内的 worktree 会变成一大片未跟踪文件。

## 3. 落地：谁都不切分支

```
git fetch origin
git rebase origin/<base>          # 在自己的 worktree 里
git push origin HEAD:<base>       # 直接把 HEAD 推成远端 base
git worktree remove … && git branch -d wt/<sid>
```

关键在第三行：**从不 checkout base，也从不碰主 checkout**。远端前进，主 checkout 里那个会话只是落后几个提交，它自己 `git pull` 跟上，工作区一秒都没被动过。

已知限制：本地 `<base>` 引用无法在别处 checkout 时被 fetch 更新（git 会拒绝 `fetch origin main:main`）。所以主 checkout 显示 behind 属正常，不是故障。

rebase 冲突则**停下来交给人**：不自动解冲突，worktree 和分支原样保留。

无 remote 的本地仓库：base 取当前分支，`land` 跳过 push，只做本地快进。

## 4. 进 worktree 之后

新 worktree 没有 `node_modules`。**按需安装，且必须让 devDependencies 装进来**——本机 shell 的 `NODE_ENV=production` 会让 npm 静默跳过它们，随后 `next build` 报一个与真因毫无关系的 `entryCSSFiles` invariant（2026-07-27 排查记录）。改文档之类不需要构建的活儿不必装。

硬规则：进了 worktree 之后，**所有编辑路径都在 worktree 内**。主 checkout 的路径从此不属于这个会话。

## 5. 清理

skill 每次运行顺带扫一遍：worktree 路径里的会话 id 已不在活会话列表里 = 孤儿。

- 工作区干净 **且** 分支已并入 base → 自动删除 worktree + 分支。
- 其余（有未提交改动、或有未合并提交）→ **保留并报告**。

宁可攒垃圾，不可吞代码。

## 6. 触发

`scripts/hook-worktree-notice.sh` 挂 `SessionStart`：它自己不做任何活性判定，直接调 `wt.sh siblings`——提示和 skill 用同一个判定，永远不会各说各话。检测到兄弟会话就往上下文注入一句「本 agent 还有 N 个活会话，改 repo 前先走 worktree skill」；独苗时零输出。**不拦截任何工具调用**——PreToolUse 硬拦虽然更保险，但每次编辑都多一道检查、误拦还会卡住干活，代价不值。

## 7. 代价（明说）

- **磁盘**：每个 worktree 是一份完整工作区，hermit-ui 装完依赖约 500MB 起。所以「有并发才隔离 + 合并即删」这个组合是必须的，不是可选的。
- **首次进入有等待**：需要构建的活儿要先装依赖。
- **skill 不是强制的**：靠开场提示 + skill 描述触发，理论上 agent 可能想不起来用。选择了这个代价以换取零拦截、零延迟。

## 8. 组件

| 文件 | 职责 |
|---|---|
| `.claude/skills/worktree/SKILL.md` | 什么时候用、进去之后的规矩、落地流程 |
| `.claude/skills/worktree/wt.sh` | `check` / `enter` / `land` / `sweep` / `siblings` 五个子命令，全部幂等；活性判定的唯一出处 |
| `.claude/skills/worktree/wt.test.sh` | 针对一次性临时仓库的自测，会话列表用环境变量注入，不依赖真 tmux |
| `scripts/hook-worktree-notice.sh` | SessionStart 探测 + 注入提示 |
| `.claude/settings.json` | 注册上面这个 hook |

先在 asst 上做通并实测，再决定铺到模板和其它 agent（6 个会话的 finance-agent 才是最需要的那个）。

---

## 实测（2026-08-05，asst 会话 pv2096yok0i0，同时有 5 个兄弟会话）

脚本自测 25 项全过（`wt.test.sh`，会话列表用环境变量注入，不依赖真 tmux）。测试抓出两个真 bug：

1. **macOS `/var` → `/private/var` 符号链接**：`git worktree list` 报的是解析后的物理路径，而脚本自己拼的路径没解析，导致 `sweep` 一个自己创建的 worktree 都匹配不上。修：启动时把 `WT_ROOT` 解析成物理路径。
2. **「已合并」不能拿本地 base 比**：本设计刻意不更新本地 `main`（没人 checkout 它），所以拿它当基准会把已经落地的 worktree 判成「有未合并提交」而永远保留。修：`sweep` 比对 `origin/<base>`，并先 fetch。

真实全流程（就在这个 repo 上）：`check` 认出 5 个兄弟会话 → `enter` 建出 `~/.hermit/worktrees/hermit-ui/pv2096yok0i0`（分支 `wt/pv2096yok0i0`，基于 `origin/main`）→ 主 checkout 期间分支和 HEAD 一动没动 → 在 worktree 里改文档、提交 → `land` 完成 rebase + `push HEAD:main` + 删除 worktree 和分支。**全程无人 checkout main。**


---

## 回归与修复（2026-08-21，claude-sdk 换底座之后）

`330c591` 把 dashboard 会话从 tmux pane 换成网关直接起的 Agent SDK 子进程。本设计的活性判定当时**整个建立在 tmux 上**，于是三处同时失效，而且一声不响：

| 位置 | 换底座后的行为 |
|---|---|
| `hook-worktree-notice.sh` | 第一行 `[ -n "$TMUX" ] \|\| exit 0` 直接退出——asst 当时 10 个并发会话，提示一次没出过 |
| `wt.sh check` | `live_sessions` 空 → 对每个会话都回答 `sole-session` |
| `wt.sh enter` / `land` | `self_id` 拿不到 `#S`，直接 `die`——skill 完全不可用 |
| `wt.sh sweep` | 活会话一个都不在列表里 → **每个活着的 worktree 都被判成孤儿**，干净且已合并的会被自动删掉 |

最后一条是数据风险，不只是失灵。修法是把「我是谁」和「谁还活着」换成两个底座都成立的信号（`HERMIT_SESSION_ID` + 进程表），tmux 降级为兜底，并把 hook 的判定合并进 `wt.sh siblings`，从此只有一处实现。

教训记一条：**这类判定必须绑在「进程/目录」这种底座无关的事实上，不能绑在某个运行方式的外壳上。** cwd 一直是那个稳定事实，`pane_current_path` 只是它在 tmux 时代的一种读法——当初写成后者，才让换底座变成了静默回归。
