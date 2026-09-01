# One PWA, Several Dashboard Deployments

_Design spec · 2026-09-01 · sequel to `workspace-switcher-design.md`_

## Problem

`workspace-switcher-design.md` gave the browser a keyring: several machines, one
active at a time, each identified by its own `X-Asst-Key`. Every one of those
machines lives on the **same dashboard** — the same origin, the same database.

A second deployment breaks that. `hermit.zhinan.tech` is a separate install with
its own Postgres, its own `Machine` rows and its own keys, and an installed PWA
is bound to **one origin**: the one it was installed from. Add-to-home-screen on
two dashboards gives two icons, two service workers, two push subscriptions and
two sets of app state. Nothing shares.

## Goal

One installed app that can drive both, switched from the same sidebar control
that already switches machines.

## Approach: the keyring entry names its backend

`KeyringEntry` gains one optional field:

```ts
type KeyringEntry = { …; baseUrl?: string | null };  // '' / absent = this origin
```

`lib/api-base.ts` turns the active entry into a prefix, and every client→server
URL is built through it:

| helper | used for |
|---|---|
| `apiBase()` | `''` for a local machine, `https://host` for a remote one |
| `apiUrl(path)` | tRPC, REST, XHR uploads |
| `mediaUrl(url)` | `/uploads/…` images, video, audio, attachments |
| `wsUrl(path)` | terminal + realtime-ASR WebSockets |

Three properties of the existing app make this cheap rather than a rewrite:

1. **The credential is a request header, not a cookie.** `x-asst-key` travels on
   every call and the server resolves it to a machine. Nothing is bound to an
   origin's cookie jar, so there is no session, SameSite or CSRF work — only a
   CORS allowance on the far end.
2. **Data fetching is entirely client-side.** 28 of 31 pages are `'use client'`;
   the other 3 are bare redirects. There is no RSC data fetch and no server
   action that would have to be reachable from another origin.
3. **Switching already does a full page reload.** So the active backend cannot
   change under a live tRPC client, SSE reader or socket, and `apiBase()` can be
   read once at construction instead of per request.

### Chosen over

- **Two installed PWAs.** Zero code, and the honest fallback — but two icons, two
  notification streams, and no way to glance at both fleets from one place.
- **Reverse-proxying the second deployment under a path of the first**
  (`dash.swaylab.ai/z/*` + Next `basePath`). Rejected: `basePath` does not touch
  the WS-upgrade regexes in `server.ts`, the two client WS URL builders, the
  gateway's `u.pathname = '/api/gateway/ws'` override, CSS `url(/…)`, the
  manifest/service-worker absolutes, ~50 `window.location.href = '/chat'`
  navigations, or the `/uploads/…` paths already written into the database. It
  also routes one deployment's traffic through the other's box.

## Server side

```
CORS_ALLOW_ORIGINS=https://dash.swaylab.ai
```

Handled in `server.ts` (`applyCors`), before the request reaches Next:

- Applies to `/api/*` and `/uploads/*` only.
- Empty list (the default) = no cross-origin access at all, i.e. exactly the
  behaviour before this existed.
- `Vary: Origin` is set whether or not the origin is allowed, so a response for
  one origin is never served from a shared cache to another.
- `OPTIONS` is answered here with a 204 and `Access-Control-Max-Age: 86400`;
  it must not reach Next, which would 405 a route that only exports GET/POST.
- Requested headers are echoed back rather than hard-coded, so adding a client
  header later can't turn into a silent CORS failure. The origin allowlist is
  the boundary; the header list is not.
- Credentials are never allowed — there is no cookie to protect, and leaving
  them off means a hostile page cannot ride anything.

## Notifications

Two things bite here, and both are configuration rather than code:

**A push subscription belongs to one VAPID keypair.** The browser mints it
against the public key it was handed and can hold exactly one per service
worker. Deployments sharing an installed PWA must therefore **share one VAPID
keypair** — copy it, don't generate a second. With two keypairs the far
deployment stores the device row happily and every send is rejected by the push
service, which looks like "notifications just don't arrive".

Registration itself needs no thought: `web-push-client.ts` and
`native-bridge.ts` already loop over the whole keyring, and each entry is now
registered against its own backend.

**A tap has to land on the right workspace.** Notification paths now carry
`?m=<machineId>` (`lib/machine-param.ts`), and `adoptMachineFromUrl()` runs
synchronously in the Providers initializer — before anything reads `apiBase()` —
so the tab comes up on the right deployment with no reload and no flash of the
wrong machine's sessions. An unknown id is ignored rather than acted on.

The second deployment should also set `PUSH_PUBLIC_ORIGIN` to **the PWA's**
origin, not its own: the tap must open the app the user actually installed.

## Limits (deliberate)

- **A machine belongs to one deployment.** The gateway has a single
  `DASHBOARD_URL`; making a machine appear on both means running two gateway
  processes, which is not supported.
- **Views stay single-workspace.** Like the machine switcher before it, this is
  a switch, not an aggregate — there is no combined inbox across deployments.
- **The marketplace is per-deployment.** `MarketSkill` and friends are
  fleet-global *within* one database; two deployments have two registries.
- **Service-worker caching and offline stay on the home origin.** The SW's
  cache-first rules are same-origin gated; a remote deployment's assets and
  thumbnails are simply fetched from the network.
- **Share links (`/s/<token>`) are origin-local.** A link minted by one
  deployment opens on that deployment.

## Scope

New: `lib/api-base.ts`, `lib/machine-param.ts`, `lib/api-base.test.ts`.

Touched: `lib/keyring.ts` (the field + a `base` argument on the two raw fetches),
`lib/asst-fetch.ts`, `app/providers.tsx`, `lib/asr-socket.ts`,
`lib/native-bridge.ts`, `lib/web-push-client.ts`,
`app/chat/terminal/terminal-view.tsx`, `app/file-station/page.tsx`,
`components/agent-files.tsx`, `components/chat/file-preview.tsx`,
`components/add-machine.tsx`, `components/login-screen.tsx`,
`components/auth-gate.tsx`, `components/workspace-switcher.tsx`,
`server/push/index.ts`, `server.ts`, `.env.example`.

No schema change, no tRPC router change, no gateway change.

## Deploying the second instance

`docs/deploy-vps.md` still describes the install. Two things differ on a box in
China (`zhinan-main`, Ubuntu 20.04):

- **`github.com` is unreachable from it** (`git ls-remote` times out), so the
  `git pull` deploy path does not work. `codeload.github.com` does respond —
  fetch a tarball, or mirror the repo to the company GitLab and pull from there.
- OpenSSL is 1.1, so Prisma needs `debian-openssl-1.1.x` in `binaryTargets`
  (currently `native` + `debian-openssl-3.0.x`; `native` covers a generate run
  on the box itself).
