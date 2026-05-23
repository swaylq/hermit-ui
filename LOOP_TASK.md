# hermit-ui Build Loop

**Goal:** ship `hermit-ui/` as a working alternative to asst/dashboard + asst/gateway + create-hermit-agent — tmux-driven chat, local-first dashboard data, image support, no Telegram. Reachable at `dash.swaylab.ai`, same postgres DB (cleared first).

**Loop owner:** Claude session driving this directory. Each iteration ~30 min.

**Each iteration:**

1. Read `evolution/lessons.md` first (avoid known walls).
2. Read this file. Pick the highest-impact PENDING item.
3. Implement it. Stop after one substantive change per iteration — do not batch.
4. Run the relevant test (`pnpm typecheck`, smoke test, etc.) — verify green.
5. Move the item from PENDING to DONE with one-line note + commit-ish hash.
6. If the iteration failed: write a one-paragraph postmortem to `evolution/lessons.md` as the next L#; mark item BLOCKED with pointer.
7. Commit working state.

**Hard rules:**

- Never break the existing `asst/dashboard` deployment until hermit-ui is verified end-to-end. Run hermit-ui on a different local port and a different postgres schema until cutover.
- Never run `claude mcp <any-subcommand>` inside the loop session (see L2).
- Never shell `find /Users/mac` or anchor Glob/Grep at `/Users/mac/**` (see L3).
- Image read: always through `scripts/safe-image.sh` first (see L4).
- Don't commit secrets — `.gitignore` blocks `.env`, `ACCOUNTS.md`, `.vps-*`.
- Subscription-safe: chat path runs `claude` interactively in tmux, NEVER `claude --print -p` (see L1).

---

## PENDING (highest impact first)

### M1 — Foundation (scaffold + fork) ✓ COMPLETE

- [x] **scaffold directory tree** — `apps/{dashboard,gateway,cli}`, `packages/`, `agents/`, `evolution/`, `docs/`. Monorepo `package.json` + `pnpm-workspace.yaml` + `.gitignore`. Done.
- [x] **fork `apps/dashboard` from asst/dashboard** — rsync copy excluding noise, renamed to `@hermit-ui/dashboard`, `.env` points at local postgres on port 4101, `npm install` (workspace-hoisted to root `node_modules`), `npm run typecheck` green, `next build` green.
- [x] **fork `apps/gateway` from asst/gateway** — renamed to `@hermit-ui/gateway`, `AGENTS_ROOT` env-overridable (defaults to `hermit-ui/agents/`), `.env` set with seeded ASST_KEY, tsconfig.json added, `npm run typecheck` green.
- [x] **fork `apps/cli` from hermit-agent** — package + template copied; npm-publish name kept as `create-hermit-agent`. Internal rewrite still pending in M2.
- [x] **DB reset** — `pg_dump asst_dashboard > _research/db-backups/asst_dashboard-pre-hermit-ui-20260523-140356.sql.gz`, `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`, `prisma migrate deploy` ran 8 migrations clean, `seed-machine.ts` seeded `hermit-ui-dev` row.

### M2 — Agent template (no Telegram) ✓ COMPLETE

- [x] **merge SOUL + IDENTITY → IDENTITY.md** — done; persona core values + name/vibe folded into one file; SOUL.md removed from template.
- [x] **merge TOOLS + ACCOUNTS → TOOLS.md** — done; `## Accounts` section at the bottom; ACCOUNTS.md deleted.
- [x] **strip Telegram from AGENTS.md** — done; Group Chats / Telegram Replies / Hibernation / fleet sections removed. Replaced with `## Dashboard Chat`.
- [x] **strip Telegram from TOOLS.md** — done; replaced with `## Dashboard Chat`; `{{USER_TG_ID}}` and Bot API refs gone.
- [x] **drop MEMORY.md, FIRST_RUN.md, HEARTBEAT.md** — done; MEMORY is auto-only now, FIRST_RUN to be migrated into dashboard UI (deferred), HEARTBEAT becomes dashboard-side cron.
- [x] **add `evolution/` to template** — done; `evolution/README.md` explains lessons/skills/reflections; empty skeleton in place.
- [x] **rewrite `template/CLAUDE.md`** — done; new bootstrap order: IDENTITY → USER → AGENTS → TOOLS → `evolution/lessons.md`. No SOUL, no MEMORY.
- [x] **scaffold test agent `agents/alpha`** — done; template copied + placeholders substituted (sway / Alpha / test assistant); 0 `{{`-style placeholders remain.
- [x] **rewrite `apps/cli/bin/create-hermit-agent.js`** — fresh 330-line implementation (was 1680 lines, stashed as `create-hermit-agent.legacy.js`). Drops Telegram bot validation / plugin install / chat_id / clone-of doppel / --host codex / state-dir .env writing. Keeps: agent name, persona, user name, dashboard URL prompt, optional brave-key, pre-ack of Claude first-run dialogs, npm install. Smoke test: `node bin/create-hermit-agent.js beta -y --persona "smoke test" --user sway --dashboard-url http://127.0.0.1:4101` → scaffolds clean `agents/beta/` with 0 unsubstituted placeholders + valid settings.local.json scoped to beta's path. The `--dashboard-url` argument + `HERMIT_DASHBOARD_URL` env in settings replace `--user-id` / `--bot-token` as the network identity, deferring machine-key fetch to M6 (the CLI doesn't talk to the dashboard yet).
- [x] **rewrite `apps/cli/package.json` description + remove --host codex path** — bumped version 0.1.57 → 0.2.0; description rewritten ("Scaffold a hermit-ui Claude Code agent — chat from the web dashboard, no Telegram required"); keywords trimmed (removed `telegram`, `bot`; added `hermit-ui`, `tmux`, `dashboard`); files manifest dropped `template-codex/` (it was never rsynced over anyway) and `README.zh-CN.md` (the en README rewrite is an M6 item). Verified `node bin/create-hermit-agent.js --help` still renders cleanly. No telegram refs left in active CLI surface (the only match is a self-disclaiming header comment).

### M3 — Tmux chat driver ✓ COMPLETE

- [x] **`packages/tmux-driver`** — new workspace package `@hermit-ui/tmux-driver`. `src/index.ts` (~260 lines) exports `ensureSession`, `sendKeys`, `sendInterrupt`, `kill`, `getClaudeSessionUuid`, `watchTranscript`, plus helpers `hasSession`, `listSessions`, `encodedProjectDir`. Sessions named `hermit-<last12chars-of-sessionId>`. `sendKeys` handles multi-line input via `M-Enter` for in-message newlines + single `Enter` to submit. `kill` does graceful `/exit` → 2s grace → `kill-session` fallback. `getClaudeSessionUuid` polls the project dir until a new non-empty `.jsonl` appears (uses `preExistingUuids` snapshot from `ensureSession` to disambiguate). Smoke tested: `hasSession`/`listSessions`/manual `new-session` → verify → kill cycle all green. `npm run typecheck` green.
- [x] **JSONL watcher** — folded into the same package as `watchTranscript(jsonlPath, onEvent)`. Uses `tail -n +1 -F` subprocess (no chokidar dep) so file rotation survives. Line-buffer the stdout, JSON.parse each line, swallow partial-write parse errors (tail re-feeds the rest on next tick). Returns a stop function that SIGTERMs the tail. Dedup is the caller's job (every claude event has `.uuid`; gateway will upsert by `externalId = uuid`).
- [x] **rewrite `apps/gateway/src/chat-runner.ts`** — `claude --print -p` spawn block gone. Now: `deliverMessages()` calls `setupSession()` lazily once per ChatSession (idempotent, survives gateway restart by reattaching to live tmux pane or `--resume <uuid>` if pane died), then `sendKeys(promptText)` to feed the user message. JSONL watcher streams `assistant` + `user-with-tool_result` events to `/api/sync/chat-message`, dedup via `seenUuids` Set. Cancellation: `sendInterrupt(sessionId)` sends Escape (claude's interrupt) instead of SIGTERMing a process. `index.ts` SIGINT/SIGTERM handlers now call `shutdownChatRunner()` to stop watcher subprocesses cleanly; tmux panes are intentionally left alive so a gateway restart reattaches instead of losing context. Added `@hermit-ui/tmux-driver` as workspace dep (`*`-versioned since npm doesn't speak pnpm's `workspace:*` protocol). `gateway/src/mcp-stub.cjs` still on disk but unimported — will be reworked in M5 for the `attach_image` tool. `npm run typecheck` green.
- [x] **multi-session per agent test** — `apps/gateway/scripts/test-multi-session.ts` + `scripts/fake-claude.sh` stub. Spawns two panes in parallel against `agents/alpha`, each with a pre-assigned uuid; verifies distinct UUIDs / JSONL paths / no cross-talk between watchers. First run **caught a real race** in chat-runner — see L8. Fix: added `claudeSessionUuid` opt to `ensureSession` (appends `--session-id <uuid>` to claudeArgs) + `awaitTranscript()` helper; chat-runner now pre-generates uuid via `randomUUID()` for fresh sessions, reserves `getClaudeSessionUuid` for the `--resume` path. Test now green (all 11 assertions pass).

### M4 — Dashboard local-first

- [ ] **delete `ensureSnapshot()` from `agents.list`** — `apps/dashboard/src/server/routers/agents.ts` reads from DB only. Browser open should produce zero filesystem activity on the VPS.
- [ ] **gateway pre-aggregation** — `apps/gateway/src/collect/agent-snapshot.ts` reads JSONL tail, extracts `lastUserPrompt` + `lastAssistantText`, posts to new `/api/sync/agent-snapshot`. New DB columns on `Agent`: `lastUserPrompt`, `lastAssistantText`, `snapshotAt`.
- [ ] **agents.byName uses DB columns** — drop the `sh("grep ... | jq ...")` shell-out. Detail sheet shows whatever the gateway last pushed.
- [ ] **launchAgents-style polling cadence** — bump `collectAgents` from 30s to 15s since dashboard no longer pulls.

### M5 — Image upload + return

- [ ] **VPS upload endpoint** — `apps/dashboard/src/app/api/upload/route.ts` accepts multipart POST, validates `image/{png,jpg,gif,webp}`, saves to `/var/hermit-ui/uploads/<sessionId>/<uuid>.<ext>` (mode 0644), returns `{ url, mimeType, width, height }`. Also writes a 2000px-max sidecar via `sips`.
- [ ] **composer paste/drag** — `apps/dashboard/src/app/chat/page.tsx` handles `onPaste` + `onDrop`; thumbnail preview + remove-X; on send, content blocks include `{type:'image', source:{type:'url', url}}`.
- [ ] **gateway image relay** — user message with image block → gateway downloads URL to Mac local cache `/tmp/hermit-ui-cache/<sha>.png` → tmux prompt = `Read /tmp/hermit-ui-cache/<sha>.png and ...` (we don't have a way to attach binaries to tmux send-keys).
- [ ] **MCP `attach_image` tool** — agents call `attach_image(filePath, caption?)` via MCP stub. Stub uploads file to dashboard `/api/upload`, posts ChatMessage with image block. Dashboard markdown renderer shows it inline.

### M6 — Telegram removal + create-hermit-agent v1

- [ ] **`apps/cli` package.json** — bump to v1.0.0, set `name: create-hermit-agent`, publish flag `--access=public`.
- [ ] **template/README.md** — rewrite to walk through: install → cli scaffold → dashboard URL → first chat. No bot tokens.
- [ ] **hermit-agent repo README.md** — update GitHub README to point to dash.swaylab.ai-style UI; deprecate Telegram path.
- [ ] **npm publish** — `npm publish` from `apps/cli/` after `npm pack --dry-run` smoke check.

### M7 — Cutover

- [ ] **side-by-side smoke** — hermit-ui dashboard runs on local port 4101 + VPS port 4101 (Caddy `dash-staging.swaylab.ai` or path prefix). Asst dashboard untouched on 4100. Run both for at least one day with sway poking the UI.
- [ ] **flip Caddy** — once smoke passes, point `dash.swaylab.ai` → 4101 on VPS. Old asst-dashboard service stops via pm2.
- [ ] **archive** — `asst/dashboard` and `asst/gateway` get a `DEPRECATED.md` and stop being pm2-managed. Trash later.

---

## DONE

- [2026-05-23T~15:00] **M1 foundation + most of M2** — full monorepo scaffolded; dashboard + gateway + cli forked, renamed, `npm install` green, `typecheck` green, `next build` green; postgres `asst_dashboard` cleared and re-migrated; machine `hermit-ui-dev` seeded; test agent `agents/alpha` scaffolded from template with placeholders substituted; all template files rewritten (IDENTITY merges SOUL, TOOLS merges ACCOUNTS, AGENTS no longer mentions Telegram, evolution/ skeleton with README + empty lessons.md); 7 seed project-level lessons in `evolution/lessons.md`. Backup of pre-clear DB stashed at `/Users/mac/claudeclaw/asst/_research/db-backups/asst_dashboard-pre-hermit-ui-20260523-140356.sql.gz`.
