# Backends are composed: one harness, one credential

Status: implemented, 2026-08-21.

Supersedes the *configuration* half of [pi-runtime-design.md](pi-runtime-design.md)
and [omp-runtime-design.md](omp-runtime-design.md) — the runtime seam those
describe is unchanged. Companion: [prime-runtime-design.md](prime-runtime-design.md).

## What was wrong

Settings → **Pi Runtime** was not a pi page. It held this machine's model
endpoint, its API key name, its model list and its default model — and three
backends already wanted exactly that. It was named after the first backend that
needed it, which is why dsh grew `dshSource: 'deepseek' | 'pi-endpoint'` instead
of naming a provider, and why adding a fifth backend would have meant a third
bespoke mechanism.

The second conflation was inside `piConfig`:

```ts
authMode?: 'api-key' | 'cc-subscription'
```

A **backend** and a **harness** were the same thing, and a harness's credential
was a global mode switch buried in one backend's settings page.

## What it is now

Two nouns instead of one.

A **harness** is the framework that runs a turn: `claude-tmux`, `pi-rpc`,
`prime-rpc`, `codex-exec`, `dsh-exec`. A **credential** is an endpoint plus the
NAME of a secret plus the models it serves. A **backend** — the thing you pick
when you start a chat — is one of each.

There are exactly two backends on a fresh machine:

| Backend | Harness | Credential |
| --- | --- | --- |
| Claude Code | `claude-tmux` | its own subscription, on this machine |
| Codex | `codex-exec` | its own `codex login`, on this machine |

They ship enabled because they need no configuration: each authenticates as
itself and there is nothing to choose. **Everything else the user composes** —
pi + hyqubit, Prime Agent + Kimi, dsh + OpenRouter — under Settings → Backends,
from credentials they added under Settings → Models. A machine that has composed
none offers two backends, and that is the intended resting state rather than a
misconfiguration.

## Claude Code became composable (2026-08-26)

`claude-sdk` moved from the built-in column to `CUSTOM_HARNESSES`, so it is now
a harness you can pair with a credential like pi, prime and dsh — "Claude Code ·
Kimi K3" is a backend a user composes, not a thing the fleet hardcodes.

The reason it can be and `claude-tmux` cannot is one line long: Claude Code
reads `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` **from its environment**,
and an SDK child's environment is ours to set. The pane takes its endpoint, key
and model from that machine's `~/.claude/settings.json` and ignores anything the
gateway hands it; codex authenticates through `codex login` and has no endpoint
to name at all. Both stay built-in.

What the gateway adds (`runtime/claude-credentials.ts`):

- the endpoint and the key, read from the machine's secret store at spawn;
- **every** model slot — `ANTHROPIC_MODEL`, the four
  `ANTHROPIC_DEFAULT_*_MODEL`s and `CLAUDE_CODE_SUBAGENT_MODEL` — pinned to the
  one model. Not belt-and-braces: a turn is many model calls, the CLI names an
  Anthropic model for the small ones, and `api.kimi.com` does **not reject** an
  unknown id — it answers on something of its choosing. An unset slot therefore
  bills a model the chat header never named, silently;
- `CLAUDE_CODE_EFFORT_LEVEL=max`, matching the `effort: 'max'` the built-in
  backend already runs;
- a deletion: an inherited `ANTHROPIC_API_KEY` is removed from the child's copy
  of the environment rather than overwritten. It is a second spelling of the
  same slot and the CLI warns rather than picking.

Refused, with a log line rather than a 404 at the first message: a credential
whose `api` is not `anthropic-messages`, one with no `baseUrl`, and one whose
named secret this machine does not hold. Each falls back to the machine's own
login, which is the one thing that can always take a turn.

Two things the composition changes elsewhere:

- **`sharesConversation` is credential-aware.** Both Claude drivers write the
  same `~/.claude/projects/<cwd>/<uuid>.jsonl`, but a transcript carries
  provider-signed thinking blocks, so replaying Anthropic's at Kimi is rejected
  at the first request. Same driver is no longer enough — the credential has to
  match too, or the external session id is dropped and the move starts a fresh
  transcript.
- **The header's model chip is hidden on a credential-backed session.** Its list
  is this machine's own `supportedModels()` — Opus, Sonnet, Haiku — and none of
  those names exists at a Kimi or GLM endpoint. That backend's model is set once
  in Settings → Backends, exactly like pi's and prime's.

A model pin still applies live (`setModel`, one control request, warm context
kept). A credential that moved does not: the endpoint and the key are read once,
at startup, so `planRuntimeSwitch` restarts a claude-sdk session whose
credential changed, and `ensure()` retires a child whose key rotated underneath
it.

### Is pointing Claude Code elsewhere a risk to the subscription?

Researched before shipping, because the fleet already refused the *opposite*
arrangement (see the next section) and the two get confused.

**Anthropic documents this direction as a supported configuration.**
`code.claude.com/docs/en/llm-gateway` — "Any gateway that exposes a supported
API format works" — and `llm-gateway-connect` describes the same-machine
coexistence explicitly: "Your claude.ai login stays saved and unused while the
variable is set; unset the variable and Claude Code goes back to it." Moonshot
and Zhipu both publish their own Claude Code setup pages. There is a "doesn't
support routing Claude Code to non-Claude models" line on the gateway page; it
is product-support language in a docs page, not a prohibition in a legal one,
and it sits in the same paragraph as "any gateway … works".

**What Anthropic actually enforces is the reverse**, and it is enforced:
`code.claude.com/docs/en/legal-and-compliance` restricts OAuth authentication to
"ordinary use of Claude Code and other native Anthropic applications", and bars
developers from routing requests "through Free, Pro, or Max plan credentials".
Anthropic began blocking Max OAuth in third-party clients in January 2026. Every
restricted act involves a claude.ai credential leaving Anthropic's own flow.
Nothing involves the CLI talking to somebody else — a Kimi session's packets
never reach Anthropic, and it burns no plan quota.

Two things follow for this code, both in `claude-credentials.ts`:

- **`CLAUDE_CODE_ATTRIBUTION_HEADER=0`.** Claude Code prepends a system-prompt
  block carrying its version and "a fingerprint derived from the conversation";
  `api.anthropic.com` strips it and, per Anthropic's own gateway-protocol page,
  "any other upstream receives it as part of the prompt". It buys nothing at
  Moonshot and it is conversation-derived.
- **`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.** Metrics are on by default
  and are only auto-disabled for the Bedrock/Vertex-style provider switches, not
  for a generic base-URL gateway.

Both are set in the composed session's spawn env only, so an ordinary
subscription session on the same machine is untouched.

Not closed off: Anthropic's automated suspension system is opaque and has
produced false positives against people running the stock CLI with no proxy at
all (anthropics/claude-code#51670). That baseline exists either way; nothing
here adds to it.

## The Claude subscription is not available to the other harnesses

It used to be, and it worked. `pi-credentials.ts` injected this host's Claude
Code OAuth token as `ANTHROPIC_OAUTH_TOKEN`, which triggered `pi-ai`'s
stealth-OAuth branch — the verbatim Claude Code identity as system block 0, the
`claude-cli` user agent, the claude-code beta — and the responses came back
`anthropic-ratelimit-unified-status: allowed`, i.e. inside the plan rather than
on extra usage. Prime Agent vendors the same `pi-ai` and the branch is intact
there too, so extending it would have been a one-line change.

**It is removed, deliberately, and not because it broke.** Pointing pi at one
Max account was already a bet; pointing pi *and* prime *and* dsh at it is
exactly what rate limits and the request classifier exist to catch, and a single
reclassification would have taken every non-Claude backend in the fleet down at
once. Claude Code keeps its own subscription, through its own tmux path, and
nothing else reaches for it.

Removed with it: the Keychain reader, the clean-`SYSTEM.md` writer, omp's
`SUBSCRIPTION_SYSTEM_PROMPT`, the `ANTHROPIC_OAUTH_TOKEN` fingerprint key, and
the `authMode` field. There is no toggle to bring it back — the code path is
gone from the gateway, which is the only way a decision like this stays made.

## Data model

```prisma
model Machine {
  // JSON ARRAY of { id, label, provider, api, baseUrl, models[], defaultModel,
  // secretKey, modelLimits } — lib/model-credentials.ts
  modelProviders Json?

  // { disabled: string[], instances: BackendInstance[], dshSource? }
  // — lib/backends.ts
  backendsConfig Json?
}
```

```ts
type BackendInstance = {
  id: string;            // slug, stored on Agent.runtime / ChatSession.runtime
  harness: 'pi-rpc' | 'prime-rpc' | 'dsh-exec';
  credentialId: string;  // → ModelCredential.id
  label: string;
  model?: string | null; // this backend's default; blank → the credential's
  mode?: string | null;  // pi only
};
```

**The two built-ins are not stored.** They always exist, and only ever appear in
`disabled`. Their ids are the harness kinds they run — unchanged from when a
backend and a harness were the same thing. That is not tidiness: every existing
`Agent` and `ChatSession` row holds one of those strings, and keeping them
identical is what let this land **without rewriting a single row**.

`secretKey` is a name in the machine's secret store. No key value has ever been
in this column and none is now.

### Legacy rows

Rows written before this change hold a bare harness name — `pi-rpc`,
`omp-rpc`, `dsh-exec`. `backendById` resolves those onto the first enabled
instance of that harness, which is what the migration creates. A machine with
no such instance degrades to the claude-tmux floor, one-directionally and with
a log line, the same way an unknown pi mode already did.

Falling to the floor rather than rendering the harness under its own name is
deliberate, and a test caught it: a `dsh-exec` row on a machine with no dsh
backend resolved to a harness with **no credential**, which would have spawned
a child that 401s at the first message with nothing on screen to explain why.
A backend whose credential is gone cannot take a turn, so the honest answer is
the one backend that always can.

## Migration

`20260821120000_model_credentials_and_backend_instances`. Additive and
reversible; `piConfig` is left in place.

- The endpoint from `piConfig` becomes a credential, and **pi paired with it
  becomes a backend**. A credential alone is not something you can start a chat
  on.
- `dshSource: 'pi-endpoint'` becomes a dsh backend on that same credential;
  `'deepseek'` becomes a `deepseek` credential (blank `baseUrl`, which is how
  the catalog spells "this harness supplies its own endpoint") and a dsh backend
  on it — created only where dsh was actually enabled, so a machine that never
  ran it does not acquire a backend it cannot start.
- The `disabled` set is carried across the rename: a machine that had pi
  switched off does not come back with its replacement switched on.
- A machine whose `piConfig` named no endpoint — never configured, or configured
  only for the Claude-subscription mode this release removes — gets **no
  credential and no instances**. There is nothing to authenticate a child with,
  and inventing a blank one would fail at the first turn instead of on the
  Backends page, where it can be seen.

`machines.pollPiConfig` stays as a **compatibility projection**: it renders the
credential the machine's first pi backend uses in the old single-endpoint shape.
The fleet's minis run a lagging gateway for days after a dashboard deploy, and
that gateway sees exactly what it saw before.

## What the gateway receives

`resolveRuntime` resolves a stored backend id into one already-decided answer:

```ts
{ backendId, runtime /* the harness */, runtimeCredentialId,
  runtimeProvider, runtimeModel, runtimeMode }
```

`runtimeCredentialId` rides on the session through `pollChatPending`, and
`machineProviderEnv(credentialId)` resolves it to the child's env at spawn. The
credential-fingerprint cache is keyed by credential id — one slot would report
the last credential resolved as "current" for every session, and a pi-on-hyqubit
child would be evicted every time a prime-on-Kimi child booted.

Below both pins sits the backend's own default model, and below that the
credential's. That is what makes a composed backend usable with nothing pinned
anywhere: "pi + hyqubit" already knows which model it means.

`planRuntimeSwitch` compares **`backendId`**, not harness. Two backends can run
the same harness against different credentials, and moving between them is every
bit as much a backend change — different endpoint, different model catalog, and
a session id the other side's provider never issued.

## UI

**Settings → Pi Runtime → Settings → Models** (`/models`; `/pi` redirects,
because the path is in the fleet's docs and in people's bookmarks).

The page is a list. At the top, the two subscriptions, read-only, each showing
whether it is **actually live on this machine** — derived from the usage
collectors rather than probed, because those only produce a row when the CLI is
installed, authenticated and reporting. Absent is reported as "未见用量上报",
not as "logged out", which would be a guess. Then the credentials, with the
endpoint presets (hyqubit, Kimi, GLM, OpenRouter, custom). Then the vision
fallback, which stays here because it is a machine-level model pair rather than
a credential a backend is built on.

**Settings → Backends** has three sections: the two built-ins with an on/off
switch each, the composed backends with a switch and a delete, and the composer
— harness, credential, name, default model, and (pi only) mode.

The picker, the agent's default-backend section and the session detail sheet all
render the machine's list through one `BackendPicker`. When that list is only
the two built-ins, the picker says so and links to Settings → Backends, because
a machine that has never been there otherwise reads as one where pi and prime
are unavailable.

## What is deliberately refused

- **Deleting a credential a backend is built on.** The backend would keep
  resolving, spawn with no endpoint and no key, and fail at the first turn with
  a 401 nobody could trace back to here.
- **Disabling every backend.** Enforced in the UI against the list it renders
  and re-checked on the server, because that is a public procedure and a machine
  with everything off would have a picker with nothing in it and no way to fix
  itself from the app.
- **An instance id that shadows a built-in.**
- **A backend naming a credential that does not exist.** Checked on the server,
  not only in the form: a dangling reference fails invisibly at spawn time.

## Testing

- `lib/backends.test.ts` — the resting state (two built-ins, nothing else),
  legacy bare-harness resolution, availability rules, the refusals, and that an
  unreadable instance is dropped rather than fatal.
- `server/runtime-resolve.test.ts` — a composed backend supplying its own
  provider and model with nothing pinned; two backends on the same harness not
  inheriting each other's pins; a legacy row still running; a legacy row with no
  backend behind it falling to the floor; an agent default being substituted
  while a session's own choice is not.
- `server/runtime-switch.test.ts` — moving between two pi backends is a backend
  change (restart **and** clear the external id), while a model change on one is
  a restart that keeps it.
- `pi-config-seed.test.ts` — the .env seeder writes a credential **and** the pi
  backend built on it, and never touches a catalog that has anything in it.
- `pi-credentials.test.ts` — no credential path can emit an Anthropic OAuth
  token any more.

## Known gaps

- **Two config shapes are in flight** until every gateway restarts. Mitigated by
  the projection, which is the only thing a lagging gateway sees.
- **A stale `model` under a switched credential.** Model ids are not portable
  between providers, and per-backend credentials make it easier to hit. Changing
  a backend's credential should clear its model; today it does not.
- **The vision fallback is still on `piConfig`.** It is a credential-shaped
  thing living outside the catalog, and it should move.
