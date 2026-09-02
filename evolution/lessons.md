# lessons.md

Distilled failure root-causes. Read before picking the next loop item.

Format: title in `##`, then **What failed** / **Why** / **How to avoid**, ≤8 lines each.

---

## L1 — the Agent SDK billing split was announced, then PAUSED (superseded 2026-08-21)

**The original lesson (2026-06-15), kept because the reasoning still matters:**
the v1 gateway routed every chat turn through `claude --print -p`. Anthropic had
announced on 2026-05-13 that from 2026-06-15 Max would split into two buckets —
Interactive (claude.ai, terminal `claude`, IDE) vs Agent SDK (`-p`, the SDK, GH
Actions, third-party apps) — with the second priced at full API rates against a
much smaller cap. Quota would have blown through the Max-20x SDK cap once
multi-agent traffic ramped. The fix was to drive interactive `claude` in a tmux
pane and read the JSONL transcript for structured output.

**What is true now:** Anthropic **paused that change on the day it was due to
take effect**. Agent SDK and `claude -p` usage draws on the ordinary
subscription limits again. Verified on this fleet's own account on 2026-08-21,
not taken from the announcement: an SDK turn reports `apiKeySource: none`,
`subscriptionType: Claude Max`, and the SAME `five_hour` / `seven_day`
utilisation windows an interactive session reports, with the would-be SDK bucket
(`seven_day_oauth_apps`) null.

**So the constraint this lesson existed to enforce is gone**, and with it the
reason the tmux path was load-bearing. `claude-sdk` is now the default backend —
same binary, same login, same transcript, reached through the supported
programmatic interface instead of by typing into a terminal UI. See
`docs/claude-sdk-runtime-design.md`.

**How to avoid re-learning this the expensive way:** paused is not cancelled, and
the failure mode if it returns is silent — nothing breaks, the fleet just starts
spending a metered credit and the first symptom is a bill. So it is watched
rather than remembered: `apps/gateway/src/collect/sdk-bucket.ts` re-reads the
plan's rate-limit windows hourly (a control request against a session that is
already running — no tokens) and alerts the moment a `*_oauth_apps` window
becomes populated. If that fires, switch agents back to `claude-tmux` — the
backend is kept for exactly this, and the switch preserves the conversation.

**The wider lesson:** this entry sat unchallenged for two months and shaped a
whole architecture around a vendor policy that had already been withdrawn. A
lesson that encodes someone else's pricing decision needs an expiry check, not
just a write-up — preferably an automated one.

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

---

## L9 — rsync `--exclude='name/'` matches at every depth, and `--exclude=.env` saves you

**What failed:** During the VPS cutover, `rsync --exclude='agents/'` (intended to skip the workspace-level `agents/` test dir) also ate `apps/dashboard/src/app/api/sync/agents/route.ts`. The next route went 404 on the VPS while every other sibling under `api/sync/` worked. Then a second pass ALSO overwrote VPS `apps/dashboard/.env` with Mac dev creds, causing Prisma "auth failed for role `mac`" 500s for ~2 min.

**Why:** rsync's unanchored `--exclude='dir/'` matches `dir/` at any depth. The cure is a **leading slash** (`/dir/`) which pins the pattern to the source root. And `.env` files are per-host secrets — rsyncing them in is wrong by default.

**How to avoid:** When sending a repo with embedded `node_modules`/`agents`/`docs` etc. dirs that share names with source paths, write `--exclude='/dir/'` not `--exclude='dir/'`. Always pair with `--exclude='apps/*/.env'`. After any rsync to a host that has its own runtime config, **manually sanity-check `.env`/`settings.local.json` before restarting services**.

---

## L10 — a setting the supervisor keeps its own copy of does not deploy with the file

**What failed:** the graceful shutdown (2026-09-02) depends on two pm2 settings,
`treekill: false` and `kill_timeout: 30000`, both written into
`apps/gateway/ecosystem.config.cjs`. Committing them changes nothing. pm2 stores
an app's settings in its own `pm2_env` when the app is first started, and
`pm2 restart <name>` restarts from that copy without re-reading the file.

**Why it is worse than a normal config bug:** every visible signal says it
worked. The file is right, the code runs the drain, the review passed — and each
restart still sends SIGINT to every `claude` child and SIGKILLs 1.6s later,
because pm2 is running the app the old way. Nothing errors. Nobody would look at
pm2's saved state to find out why a feature that is clearly present does nothing.

**How to avoid:** for anything a supervisor caches (pm2 `pm2_env`, systemd's
loaded unit, launchd's loaded plist, a container's created-with flags), the
deploy step is the *file*, not the name — `pm2 startOrRestart <file> && pm2 save`
— and the program should CHECK ITS OWN supervision at startup and say so when it
is wrong. `src/pm2-config-check.ts` does that with one `pm2 jlist`, printing the
exact command that fixes it. A check the program runs on itself is the only kind
that survives someone restarting it the convenient way.

**Corollary:** `pm2 startOrRestart <file>` restarts EVERY app in that file, so
two processes with different lifecycles need two files. The session host lives in
`ecosystem-session-host.config.cjs` precisely so that deploying a gateway change
cannot end every session the host is holding.
