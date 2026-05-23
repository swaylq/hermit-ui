# lessons.md

Distilled failure root-causes. Read before picking the next loop item.

Format: title in `##`, then **What failed** / **Why** / **How to avoid**, ≤8 lines each.

---

## L1 — `claude -p` falls in Agent SDK billing bucket starting 2026-06-15

**What failed:** v1 gateway routed every chat turn through `claude --print -p`. Quota would have blown through Max-20x's $200/mo SDK cap once multi-agent traffic ramped.

**Why:** Anthropic split Max into two buckets — Interactive (claude.ai chat, terminal `claude`, IDE) vs Agent SDK (`-p` flag, SDK, GH Actions). `-p` lands in the smaller bucket priced at full API rates.

**How to avoid:** Run `claude` interactively inside a tmux pane and drive it via `tmux send-keys`. JSONL transcript under `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` provides the structured events; never parse the TUI capture-pane output (ANSI hell). See `skills/tmux-claude-driver.md` for the working pattern.

---

## L2 — `claude mcp <any-subcommand>` kills the running session

**What failed:** Two sibling agents in 2026-04-23 ran `claude mcp add` and `claude mcp list` mid-session, lost every MCP handle (Telegram/playwright/brave), went dark for hours.

**Why:** Even `list` triggers MCP registry reconnect, invalidating every deferred MCP tool schema in the session.

**How to avoid:** Stop the agent before `claude mcp …`, then `restart.sh`. In hermit-ui gateway code that needs to inspect MCP, parse `~/.claude/settings.json` directly — never shell out to `claude mcp`.

---

## L3 — Recursive search on macOS wedges Node event loop

**What failed:** `find /Users/mac` and `Glob /Users/mac/**` both wedged claude main process for 10+ min, only recovery was `kill -9`.

**Why:** `~/Library/Containers` has 100k+ files. Even with `-maxdepth 5`, the ripgrep / find subprocess blocks long enough that Node event loop never reaps it cleanly.

**How to avoid:** Pin narrow roots. For hermit-ui gateway code that walks the agent tree, anchor on `/Users/mac/claudeclaw/<agent>/`, not the user home. Use `mdfind -onlyin <dir>` for filename lookups.

---

## L4 — Image with long edge > 2000px crashes session

**What failed:** Multiple agents Read'd full-page playwright screenshots (~2880px) → all subsequent API calls returned 400 until restart.

**Why:** Anthropic image dimension limit, but error message is silent for the rest of the turn — including the reply path.

**How to avoid:** For hermit-ui image upload, `scripts/safe-image.sh` (existing in asst/) downsizes to 2000px before storage. Gateway must call it on upload AND on every read into a model prompt.

---

## L5 — Stop hooks don't fire on abnormal turn exit

**What failed:** API 500 / TLS / cancellation paths skip the Stop hook, so `.claude/state/session-status.json` stays stuck at `state=running` forever.

**Why:** Stop hook only fires on normal turn completion.

**How to avoid:** Don't trust session-status state for liveness. In hermit-ui, derive `alive` from `agent.pid` + `kill -0`, not from a hook-written state file. (status-reporter v0.1.23+ has a self-healing `pane_state_check` but we shouldn't import that dep.)

---

## L6 — pnpm catalog vs npm workspaces

**What failed:** _(placeholder — fill in once we hit a real monorepo build issue)_

**Why:** _(tbd)_

**How to avoid:** _(tbd)_

---

## L7 — Postgres migration on shared DB

**What failed:** _(placeholder — fill in if we break asst's running tables when migrating hermit-ui schema in)_

**Why:** _(tbd)_

**How to avoid:** Always `pg_dump` the asst_dashboard DB to a timestamped file before running any new `prisma migrate`. Use a separate schema namespace `hermit_ui` if conflicts arise.

---

## L8 — `getClaudeSessionUuid` polling races when sessions share a cwd

**What failed:** Multi-session test spawned two tmux panes against the same agent cwd in parallel. Both `getClaudeSessionUuid` calls polled `~/.claude/projects/<encoded>/` after the same `preExistingUuids` snapshot, both saw the FIRST new `.jsonl` to appear, and both returned the same uuid. Result: both watchers tailed the same file, cross-contaminated, the second pane's transcript was orphaned.

**Why:** "Pick the first new file in the dir after spawn" can't tell which file belongs to which spawn when multiple spawns are concurrent. The snapshot-diff approach assumes one writer at a time.

**How to avoid:** Pre-assign claude's session uuid via `claude --session-id <uuid>` (added to `EnsureOpts.claudeSessionUuid` in `@hermit-ui/tmux-driver`). Then the JSONL path is known up-front; no scan needed. `awaitTranscript(path)` waits for that specific file. Reserve `getClaudeSessionUuid` for the `--resume` path only (where claude forks into a new uuid we can't predict).
