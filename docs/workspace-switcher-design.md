# Workspace Switcher — Multi-Machine Browser Keyring

_Design spec · 2026-06-03_

## Problem

The dashboard backend is already fully multi-machine: every model is scoped by
`machineId`, the gateway WebSocket in `server.ts` is keyed by `machineId` (multiple
hosts coexist), and `npm run seed <name>` mints additional `Machine` rows + keys.

The **browser** is the only single-machine layer. It stores exactly one
`X-Asst-Key` in `localStorage` and sends it on every request, so a browser session
can see exactly one machine. There is no way to view or switch between machines.

## Goal

A top-left **workspace switcher** that lets one browser hold several machines and
flip between them. Picking a machine scopes the entire dashboard (chat, agents,
cron, skills, usage) to that machine.

## Approach: browser keyring (client-only)

The browser holds a **keyring** — a list of `{ machine, key }` entries — and sends
the *active* machine's key on every request. The server already scopes everything
by `active key → machine`, so **no schema change and no new endpoints are needed**.
This preserves the existing security boundary: each key only grants access to its
own machine; holding a key in the browser is the same trust as today, just N of
them instead of one.

Rejected alternative — an *owner login* that sees all machines with one credential
— would be nicer UX but requires a new auth surface (`machines.list`, an owner
session) and changes the trust model. Not worth it for a single-operator tool.

## Components

### 1. Keyring storage (`app/providers.tsx`)

Replace the single-key helpers with a keyring:

```ts
type KeyringEntry = { id: string; name: string; key: string; hostname?: string | null };
```

- `localStorage['asst-dashboard-keyring']` — `KeyringEntry[]`
- `localStorage['asst-dashboard-active']` — active machine `id`
- **Migration:** if the legacy `asst-dashboard-key` exists, fold it into the keyring
  as the first entry (resolve `name`/`hostname` lazily via `machines.me`) and delete
  the legacy key. Existing sessions keep working with no re-login.
- `getActiveKey()` returns the active entry's key. The tRPC client's `headers()` and
  the SSE/terminal fetches read `getActiveKey()` (the client is created once;
  `headers()` runs per request, so switching needs no client rebuild).

Helpers: `getKeyring()`, `getActiveKey()`, `getActiveEntry()`, `setActiveMachine(id)`,
`addMachine(entry)`, `removeMachine(id)`.

### 2. Switching = set active + full reload

`setActiveMachine(id)` then `window.location.href = '/chat'`. A hard reload rebuilds
the client with the new active key, so the React Query cache, the chat SSE stream,
and the terminal control WS all reset cleanly — zero stale machine-1 data leaking
under machine 2. Switching is a low-frequency action; a ~300ms reload is an
acceptable price for correctness (mirrors how Slack/VS Code treat workspace
switches). It also sidesteps the known Next-16 programmatic-navigation quirk
(custom server + `router.push` to the same route doesn't navigate; `window.location`
is the reliable path).

### 3. Switcher UI (`components/workspace-switcher.tsx`, new)

Rendered at the **top of the sidebar** (replacing the bare logo block).

- Resting state: active machine avatar (initials) + name + chevron. Collapsed
  sidebar (60px) shows just the avatar.
- Click opens a dropdown: every keyring machine as a row (status dot, name,
  hostname, check on active) + an "Add machine" action at the bottom.
- Built with a plain `createPortal` popover + self-managed Esc/scroll-lock/outside-
  click — **not** base-ui `Dialog`, which has documented composition-layer quirks in
  this app (static `opacity:0` backdrop, translucent descendants compositing away).

### 4. Add / remove machine

- **Add:** the dropdown's "Add machine" reveals an inline input. Paste a key →
  validate by fetching `machines.me` with that key → on success append
  `{ id, name, key, hostname }` to the keyring and switch to it; on failure show an
  inline error. (Optionally surface the `seed` + gateway-install hint as helper
  text.)
- **Remove:** each row has a remove control. Removing the active machine switches to
  the first remaining entry; removing the last one returns to the login screen.

### 5. Online status dots

When the dropdown opens, fire one `machines.me` per keyring key in parallel (raw
`fetch`, each with its own key — the shared tRPC client only carries the active
key). Treat `lastSeen < ~90s` as online (●) else offline (○). Cheap and cacheable;
purely informational.

### 6. AuthGate / LoginScreen / sign-out

- `auth-gate.tsx`: gate on "keyring non-empty" instead of "has key". Empty →
  `LoginScreen` (adds the first machine). On the active key being rejected, offer to
  remove it / switch.
- `login-screen.tsx`: on submit, validate and add as the first keyring entry.
- Sign-out removes the **active** machine from the keyring (not a global wipe);
  emptying the keyring returns to the login screen.

## Scope

**Files (all client-side):** `app/providers.tsx`, `components/auth-gate.tsx`,
`components/login-screen.tsx`, `components/app-sidebar.tsx`, and the new
`components/workspace-switcher.tsx`. No gateway, schema, tRPC-router, or sync-route
changes.

**Out of scope (deferred):** owner-level auth; dashboard-driven machine minting
(still seeded via `npm run seed` on the dashboard host); cross-machine aggregate
views (each view stays single-machine, scoped to the active key).

## Decisions (approved)

1. Switching does a full page reload (no in-place cache swap).
2. Online status dots included.
3. Sign-out removes the current machine (not a global clear).
4. Switcher lives at the sidebar top (not the footer).
