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

### M4 — Dashboard local-first ✓ COMPLETE

- [x] **delete `ensureSnapshot()` from `agents.list`** — removed all 3 callsites (`agents.list`, `agents.byName`, `tasks.list`) plus their imports. Deleted now-orphaned files: `apps/dashboard/src/server/collect/{snapshot,agents,launchAgents}.ts` (gateway owns this collection on the Mac side; dashboard never reads FS on the VPS). The shell-grep snippets in `agents.byName` for `lastUserPrompt`/`lastAssistantText` are still there — they only fire on detail-sheet open, and M4.3 will lift them into DB columns. `npm run typecheck` + `next build` both green.
- [x] **gateway pre-aggregation** — added `Agent.lastUserPrompt` / `lastAssistantText` / `snapshotAt` columns via prisma migration `20260523141945_add_agent_snapshot_fields` (pg_dump backup at `_research/db-backups/asst_dashboard-pre-m4-2-…` per L7). New collector `apps/gateway/src/collect/agent-snapshot.ts` walks `AGENTS_ROOT`, finds newest jsonl per agent (using `encodedProjectDir` from `@hermit-ui/tmux-driver`), `tail -n 500` each, parses newest-first to find the latest user prompt (skipping tool_result echoes) + latest assistant text, slices to 600 chars. New `apps/dashboard/src/app/api/sync/agent-snapshot/route.ts` upserts via `updateMany` (silently skips agents not yet in DB). Wired into gateway `index.ts` on a 60s loop. Smoke: tsx eval against `alpha`/`beta` returned 2 agents, alpha resolved to the prior fake-claude transcript correctly. Typecheck + `next build` green; new route `/api/sync/agent-snapshot` registered.
- [x] **agents.byName uses DB columns** — `apps/dashboard/src/server/routers/agents.ts` no longer shells out. The two `sh("grep '\"type\":\"user\"' … | jq -r …")` blocks are gone; `byName` returns `lastUserPrompt` / `lastAssistantText` straight from the `Agent` row (gateway pre-aggregates them on its 60s snapshot tick). Also dropped the unused `spawnSync` import + `sh()` helper. `typecheck` + `next build` green; `/agents` page compiles statically. Detail sheet UI doesn't need any change — same response shape.
- [x] **launchAgents-style polling cadence** — `apps/gateway/src/index.ts`: `loop(pushAgents, 30_000)` → `15_000`. Header comment block updated with the new cadence and a one-line note about why (dashboard never pulls). `typecheck` green.

### M5 — Image upload + return ✓ COMPLETE

- [x] **VPS upload endpoint** — `apps/dashboard/src/app/api/upload/route.ts` accepts multipart POST. Auth via `X-Asst-Key` + sessionId-belongs-to-machine check (refuses cross-tenant writes). Validates MIME in `{png,jpg,jpeg,gif,webp}` + 25MB cap. Writes original to `<HERMIT_UPLOAD_DIR>/<sessionId>/<uuid>.<ext>` (default `/var/hermit-ui/uploads` on linux, `/tmp/hermit-ui/uploads` on darwin), then a safe sidecar `<uuid>.safe.<ext>` resized to long-edge ≤2000px via `sips` (mac) or `convert` (linux). If neither resizer is installed, falls back to byte-for-byte copy + flags `resized:false` in response. Returns `{url, originalUrl, mimeType, width, height, bytes, resized}`. URL points at `.safe.*` so downstream consumers can't accidentally hit L4. GET serving (`/uploads/[...path]`) lives in the next iteration with the composer wiring. `typecheck` + `next build` green; `/api/upload` registered.
- [x] **composer paste/drag** — full pipeline: paste/drop in `apps/dashboard/src/app/chat/page.tsx` → `POST /api/upload` (X-Asst-Key from localStorage) → optimistic `URL.createObjectURL` thumbnail with `uploading…` state → swap to ready with `WxH` label on response → remove-X revokes the blob URL. `Attachment` discriminated union (`uploading | ready | error`). Drag enters tint `bg-accent/30` on the form. Submit needs ≥1 of text/ready-image; payload `{sessionId, text, images:[{url,mimeType,width,height}]}`; `setDraft('')+setAttachments([])` on success. New GET handler `apps/dashboard/src/app/uploads/[...path]/route.ts` streams from `HERMIT_UPLOAD_DIR` with resolve+startsWith path-traversal guard, `cache-control: immutable`. `chat.send` (`apps/dashboard/src/server/routers/chat.ts`) now takes `images` (max 10) and builds Anthropic-style content blocks `[{text}, {image,source:{type:'url',url,media_type},width?,height?}…]`. `MessageRow` renders inline image blocks (`groupConsecutiveTools` gets `kind:'image'`; `<img src=… max-w/h 320px>` wrapped in `<a target=_blank>`). `typecheck` + `next build` green; `/api/upload` + `/uploads/[...path]` both registered.
- [x] **gateway image relay** — new `apps/gateway/src/image-relay.ts` (~140 lines): `extractImages(content)` pulls `{url,mimeType,base64Data}` from Anthropic-format `image` blocks (handles both `source.type:'url'` and `source.type:'base64'`); `ensureCached(img)` writes to `$HERMIT_IMAGE_CACHE_DIR` (default `/tmp/hermit-ui-cache/`) using `sha256(url|b64-prefix).slice(0,32)` filename + ext from URL path/mime, idempotent (skips if file exists), absolutizes relative `/uploads/…` against `DASHBOARD_URL`, warns if URL lacks `.safe.` marker; `relayImages(contents)` returns `{paths, errors}`. `apps/gateway/src/chat-runner.ts` `deliverMessages` now calls `relayImages` on the batch, posts a `[gateway]` system row for any failed downloads (non-fatal), and assembles the tmux prompt as `<text>\n\nRead <p1>\n\nRead <p2>…` so claude consumes each image via its Read tool. tmux `send-keys` only carries text, so this Read-injection is the only way to pipe bytes into claude's context. `typecheck` green; smoke test (base64 + non-existent URL) → 1 cached file, 1 error, deterministic SHA-named output.
- [x] **MCP `attach_image` tool** — `apps/gateway/src/mcp-stub.cjs` rewritten: renamed env vars to `HERMIT_SESSION_ID`/`HERMIT_DASHBOARD_URL`/`HERMIT_KEY`, server name `hermit-mcp v0.2.0`, MCP server label `hermit` (so tools surface as `mcp__hermit__*`). Added `attach_image(filePath, caption?)`: stat → read → multipart POST to `/api/upload` → POST `/api/sync/chat-message` with `role:'assistant'` + optional caption text block + image block carrying the returned safe url. `apps/gateway/src/chat-runner.ts`: every fresh / `--resume` spawn now passes `--mcp-config <json>` via `buildMcpConfigArg(sessionId)`, threading session-scoped env into the stub child. Reattach path skips the flag (in-pane claude already inherited it). Smoke: piped 3 JSON-RPC frames to the stub → `initialize` returns serverInfo, `tools/list` returns all 3 tool schemas, `attach_image('/nonexistent')` returns `isError:true` with a clean message. `typecheck` green.

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
