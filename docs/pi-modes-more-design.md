# More pi modes — frontend, consultant, writer

Status: implemented, 2026-08-06. Companion to [pi-modes-design.md](pi-modes-design.md).

## Goal

`pi-modes-design.md` established the recipe and shipped `coding` and `ops`; `omp` then
joined as the full-tool engine. This adds three modes for the work the fleet was already
doing on pi but had no recipe for: **UI work** (browser screenshot verification) and
**consultation** (text dialogue + web research), plus **writer** as the first lean
pi-engine craft mode.

Together they exercise the two axes a mode picks along:

- **Engine** — omp's 31 built-in tools vs pi's four. A mode declares it in `mode.json`
  (`engine`), and `buildModeArgs` reads the `tools` list in that engine's vocabulary.
- **Discipline** — the SYSTEM.md appended to the base prompt, resident every turn.

## The modes

### `frontend` — engine `omp`

UI work in a real browser. Runs on omp for `browser`, `inspect_image`, `lsp`,
`ast_edit` — the screenshot-verify loop needs real rendering, not a fetch of the HTML.

SYSTEM.md encodes the loop: read the component *and* the rendered page before judging;
change small and verify after every edit; **never report a UI fix without a fresh
screenshot**; compare before/after (a fix that moves the bug is not a fix); test the
target viewports, not just the desktop width; accessibility is part of the UI.

No `tools` (full omp surface), no extensions.

### `consultant` — engine `omp`

Research-backed advice. Runs on omp for `web_search`, `fetch`, `read`. Exa's hosted MCP
works **keyless** (verified 2026-08-06: `web_search_exa` returns results with no
`exaApiKey` param), so no API key and no custom extension.

SYSTEM.md: research before advising (search and read, don't compose from memory); never
invent a quote, chapter, study, or statistic; lead with the answer then reasoning then
actionable next steps; cite sources and separate fact from judgment; state confidence;
ask the clarifying question only after showing you can start.

### `writer` — engine `pi`

Long-form prose. Stays on pi on purpose: `tools: ["read","bash","edit","write","grep"]`
plus hermit's six unioned by `buildModeArgs` = **11 tools** against omp's 31 — the
31-tool schema is standing context tax a pure-prose mode does not need.

SYSTEM.md: outline before drafting; lead with the point; strong openings and closings;
concrete over abstract; four editing passes (structure → clarity → word choice →
cadence); never pad to a length; the user's edits are the source of truth.

## Design decisions

- **Engine is per mode, chosen by what the work needs.** frontend and consultant need
  tools only omp ships (`browser`, `web_search`); writer needs none, so it stays on pi.
  This is not a fleet default flip — `DEFAULT_MODE` remains `omp`.
- **No custom extensions.** All three are pure `SYSTEM.md` + `mode.json`. `ops` needed
  `ssh_run` because a prompt cannot remember four credential rules per call; nothing
  here has that shape yet.
- **Mode-local skills are pi-only.** omp filters its own skill discovery and never reads
  a mode's `skills/` dir, so an omp mode's discipline must be resident in SYSTEM.md.
  writer (pi engine) keeps the door open for a future `editing-passes` mode-local skill.
- **System-prompt budgets.** The three SYSTEM.md files are 2–3KB each and resident every
  turn, so they carry only discipline, never site knowledge. Books, hosts, and
  conventions stay in skills, loaded on demand.

## Testing

- **Unit** — four new tests in `pi-modes.test.ts` read the on-disk recipes and assert
  engine choice, SYSTEM.md presence, and (for writer) the hermit-tool union. Gateway
  suite: 185 pass.
- **E2E against a live hyqubit child** (2026-08-06):
  - `consultant` used `web_search`, returned a cited, confidence-qualified consultation
    (protein-intake question → pubmed sources, confidence stated, cutting-vs-bulking
    nuance).
  - `writer` produced a blurb matching its discipline: point first, concrete details,
    active voice, no filler.
  - `frontend` reproduced its screenshot-verify rules verbatim when asked.
- **Note on the pi engine** — the writer recipe was smoke-tested on the omp binary
  (same tool names, same SYSTEM.md); the pi engine's own RPC path is the gateway's
  existing production path (pi sessions run on hyqubit daily). pi's *print-mode* CLI
  resolves the model before extensions load, so it cannot register a custom provider —
  a CLI limitation of the smoke test, not a mode bug.

## Rollout

- Dashboard picker (`apps/dashboard/src/lib/pi-modes.ts`) now lists six modes; built-in
  modes ship in the same deploy as the gateway, so both machines get them from one
  deploy.
- Existing sessions unaffected: a mode is stored per session; a session that never
  picked one still resolves to `omp`.

## Roadmap — the next modes

Candidates, cheapest first, with the axes that would define each:

| mode | engine | tools that matter | SYSTEM.md themes |
| --- | --- | --- | --- |
| `data` | pi | read/bash/edit/write/grep + a sqlite-reader extension | analysis discipline: verify every number, no fabrication, reproducible steps |
| `social` | omp | browser, image-gen | platform conventions (小红书/XHS, twitter), hook-first, visual + text pairing |
| `research` | omp | web_search, fetch, read, task | deeper than consultant: source grading, claim-vs-evidence tables, a deliverable report |
| `knowledge` | pi | read/bash/edit/write | knowledge-base editor: durable, evergreen, searchable notes |
