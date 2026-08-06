# pi modes — one backend, several kinds of work

Follows on from [pi-runtime-design.md](pi-runtime-design.md), which added pi as a
second backend. That work made pi *available*. This makes it *good at a
particular job*.

## Goal

A pi session should start already knowing how its kind of work is done well.
Ops work is not coding work: the failure modes are different, the tools are
different, and the discipline that stops an agent from reporting a wrong answer
is different. Today every pi session gets the same ~1000-token core prompt and
the same four tools, whatever it has been opened to do.

A **mode** is the spawn recipe for one kind of work: text appended to pi's system
prompt, a tool allowlist, the skills worth loading, extensions, and optionally a
model. It is chosen when the session is created.

## Non-goals

- **A permission system.** A mode is craft, not a boundary. `ops` includes
  `bash`, which can do anything; the point is that the agent investigates well,
  not that it is fenced in. Guard rails exist (`ssh_run` keeps credentials out of
  argv) but they are a side effect of making the right thing easy, not the
  feature.
- **Switching mode mid-conversation.** A mode is expressed entirely as spawn
  arguments, so changing one means a new child. The dashboard's backend picker
  can move a session's mode and hibernates it to do so; there is no `/mode`
  command inside a session, and adding one would mean one context carrying two
  personas.
- **A mode marketplace.** Modes ship in this repo. A machine can add or shadow
  one locally; that is the whole extensibility story for now.

## Data model

Mode rides alongside the existing runtime columns and inherits the same way.

```prisma
model Agent       { runtimeMode String? }   // default for this agent's new sessions
model ChatSession { runtimeMode String? }   // null = inherit the agent's
```

`resolveRuntime` resolves it with provider and model, in one place, so the
gateway receives a decided answer. Two rules beyond the existing ones:

- **Not pi, no mode.** The resolver returns `null` for `claude-tmux`. A mode is a
  pi spawn recipe and the tmux path cannot honour one; returning a value there
  would be something the gateway must remember to ignore.
- **Unknown names are not errors.** The name is stored in the DB, the recipe is
  on disk. A session created against a mode that was later renamed, or that
  synced from a machine which has it when this one does not, must still start.
  `resolveMode` falls back to the default and logs it, degrading to plain pi —
  which is exactly what the session would have been before modes existed. No FK,
  no CHECK constraint.

`planRuntimeSwitch` treats mode like provider and model: pi bakes it into the
child at spawn, so changing it restarts the child.

## Where modes live

On disk, not in the DB, because a mode carries extension **code** and a JSON
column cannot hold that.

```
apps/gateway/pi-modes/<name>/mode.json        the recipe
apps/gateway/pi-modes/<name>/SYSTEM.md        appended to pi's system prompt
apps/gateway/pi-modes/<name>/extensions/*.ts  loaded with --extension
apps/gateway/pi-modes/<name>/skills/*         mode-local skills
```

Built-ins ship in this repo so both machines get them from one deploy. A machine
may add or shadow a mode by name under `$AGENTS_ROOT/.hermit/pi-modes/`.

**Site knowledge deliberately does not live in a mode.** Which hosts exist, which
service has which quirk — that belongs in skills, loaded on demand, and in
machine-local config. A mode's SYSTEM.md is resident on every turn of every
session in that mode; putting the japan-dev Caddy bug there would make every ops
session pay for a runbook it may never open. The first draft did exactly that and
came to ~2000 tokens, twice pi's entire core prompt. Moving site knowledge out
halved it.

The dashboard's picker list (`apps/dashboard/src/lib/pi-modes.ts`) is a static
table rather than a fetch: built-in modes ship in the same deploy, and a picker
that blocks on a machine round-trip to render three options is not worth the
column plus push path. Drift fails softly and one-directionally — an option the
machine lacks degrades to the default with a log line; a mode on disk that is not
in the table is simply not offered.

## Expansion, and the `--tools` trap

`buildModeArgs` turns a mode into CLI arguments appended after hermit's own
extension:

```
--extension <mode ext>…  --tools <list>  --skill <path>…  --append-system-prompt <text>
```

Two things measured rather than assumed:

**`--tools` allowlists extension tools too.** Verified against the real CLI:

| flags | tools pi reported |
|---|---|
| none | `read, bash, edit, write` + hermit's six |
| `--tools read,grep,find,ls` | `read, grep, find, ls` — **hermit's six all gone** |
| `--tools read,grep,describe_image,ask` | `read, grep, describe_image, ask` |

A mode listing only the built-ins it wants would silently lose `ask`,
`attach_image`, `describe_image` and the rest — i.e. the dashboard's whole
interaction path, failing invisibly. So `buildModeArgs` unions `HERMIT_TOOL_NAMES`
in; a mode author cannot forget.

That table also shows pi activates only `read/bash/edit/write` by default —
`grep/find/ls` exist but are off unless named. Both shipped modes turn them on.

**`--append-system-prompt` takes text, not a path.** The gateway reads SYSTEM.md
and passes its contents. Appending rather than `--system-prompt` keeps pi's core
prompt, which mode text is written to complement.

## The modes

**`coding`** — the default, so every pi session that never picked one lands here,
and therefore deliberately thin. Its only change against pre-modes pi is turning
on `grep/find/ls`. It has no SYSTEM.md yet on purpose: a coding prompt is the one
thing to harvest rather than invent. `bigpowers` (MIT, 87 skills — `develop-tdd`,
`investigate-bug`, `diagnose-root`, `map-codebase`, `verify-work`) and `gentle-pi`
(MIT) are the sources. Curate, do not install wholesale: pi keeps every skill's
name and description permanently in the system prompt, so 87 of them is a
standing context tax, and `bigpowers` also brings a `specs/epics/` project
structure this repo does not use.

**`ops`** — live machines. Its SYSTEM.md is a translation and rewrite of
HolmesGPT's investigation prompt (Apache-2.0, CNCF Sandbox), with the Kubernetes
guidance dropped; provenance is recorded in `mode.json`'s `attribution`. What it
buys is the discipline that separates a finished investigation from an abandoned
one: five whys, always read the logs, treat error text as exact evidence
(`authentication failed` means the user *exists*), never silently substitute a
similarly-named entity, distinguish "I found the cause" from "I could not
finish".

It ships one extension, `ops-tools.ts`, providing `ssh_run` and `ssh_hosts`.
This is the part a prompt cannot do: running a privileged remote command
correctly means remembering not to put the password in argv, not to echo it, to
feed `sudo -S` from stdin, and to use the non-standard port — four rules on every
call. `ssh_run` makes it one call. Hosts come from
`$AGENTS_ROOT/.hermit/ops-hosts.json`, machine-local so no address or secret name
is committed; the file names a *secret key*, never a value, and `ssh_run` reads
it at call time.

## Testing

`pi-modes.test.ts` covers argument expansion — the hermit-tools union, missing
extensions and skills being skipped rather than failing a spawn, mode-local
skills shadowing the agent's, prompt-as-text. `runtime-resolve.test.ts` and
`runtime-switch.test.ts` cover inheritance and the restart rule.

End-to-end, against a real pi child on the hyqubit endpoint:

- ops mode reports `read, bash, grep, find, ls, edit, ssh_run, ssh_hosts` plus
  hermit's six — extension loaded, union applied.
- Asked to check japan-dev read-only, it used `ssh_run`, correctly reported
  rathole's PID and tunnel ports, Caddy active on `:8443` with `:443` owned by
  xray (which it could only know from the `japan-dev-ops` skill, so `--skill`
  landed), and verified two subdomains returned HTTP 200.

## Rollout

Existing rows have `runtimeMode = null`. Every current pi session resolves to
`coding`, whose only effect is three extra read-only tools; claude sessions
resolve to `null` and are untouched. The migration is behaviourally a no-op.
