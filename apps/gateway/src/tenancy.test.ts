// P2-1 construction-enforcement — a static-scan invariant over the dashboard's tRPC
// routers. Every `agentProcedure` endpoint accepts scoped `shr_` share keys, so it MUST
// scope to the caller's agent by exactly one of: an `agentName`/`name` input field
// (auto-asserted in trpc.ts), a `ctx.assertAgent(loadedName)` call, or a
// `ctx.scopedAgent`-constrained query (fileManager routes this through `fsTarget`). An
// id-keyed endpoint that scopes by NONE of these reaches SIBLING agents' data — and it
// compiles + passes review. That is exactly the `fileManager.downloadStatus` gap the
// run-10 tenancy audit found (now fixed). This test fails if a FUTURE agentProcedure
// endpoint ships unscoped, so the "forget once → cross-agent leak" class can't regress.
//
// It's hosted in the gateway harness because that's the repo's only test runner; it only
// reads dashboard SOURCE TEXT (no import, no runtime coupling). Heuristic by nature — it
// can only miss a forget (false negative), never fail a correctly-scoped endpoint, since
// any one scoping token present = pass.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Walk up from the test's cwd to find the dashboard routers dir (robust to how the
// suite is invoked: `pnpm --filter @hermit-ui/gateway test` runs in apps/gateway,
// root `pnpm -r test` runs per-package).
function routersDir(): string {
  let d = process.cwd();
  for (let i = 0; i < 8; i++) {
    const cand = path.join(d, 'apps/dashboard/src/server/routers');
    if (fs.existsSync(cand)) return cand;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  throw new Error(`could not locate apps/dashboard/src/server/routers from ${process.cwd()}`);
}

const ROUTER_FILES = ['chat.ts', 'cron.ts', 'fileManager.ts', 'interaction.ts', 'agents.ts', 'share.ts'];
// Any ONE of these tokens in an endpoint's (schema-expanded) body proves it scopes to the
// caller's agent. `agentName`/`name: z.string` = an auto-asserted input field; `assertAgent`
// = a manual id-load assert; `scopedAgent`/`fsTarget` = a scopedAgent-constrained query.
const SCOPING_TOKENS = ['assertAgent', 'scopedAgent', 'fsTarget', 'agentName', 'name: z.string'];
const PROC_RE = /(\w+):\s*(agentProcedure|machineProcedure|gatewayProcedure|publicProcedure|authedProcedure)\b/g;

// An endpoint may factor its zod input into a named const (e.g. `.input(CronInput)` where
// `const CronInput = z.object({ agentName, … })`). A text scan of the endpoint body alone
// can't see the `agentName` field then, so splice each `.input(<Ident>)` reference's
// definition text into the body before scanning. Inline `.input(z.object({…}))` needs no
// expansion (the fields are already in the body); the regex ignores it (bare identifier
// only). An imported/unresolved schema simply appends nothing.
function expandInputSchemas(src: string, body: string): string {
  let out = body;
  const inputRe = /\.input\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = inputRe.exec(body))) {
    const decl = new RegExp(`\\nconst\\s+${m[1]}\\s*=[\\s\\S]*?\\n(?=const |export |\\w+Router\\b)`).exec(src);
    if (decl) out += decl[0];
  }
  return out;
}

// Slice each router into per-endpoint bodies (a declaration to the next declaration) and
// return the agentProcedure ones with their schema-expanded source text.
function agentEndpoints(src: string): Array<{ name: string; body: string }> {
  const marks: Array<{ name: string; kind: string; index: number }> = [];
  PROC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PROC_RE.exec(src))) marks.push({ name: m[1], kind: m[2], index: m.index });
  const out: Array<{ name: string; body: string }> = [];
  for (let i = 0; i < marks.length; i++) {
    if (marks[i].kind !== 'agentProcedure') continue;
    const end = i + 1 < marks.length ? marks[i + 1].index : src.length;
    const body = src.slice(marks[i].index, end);
    out.push({ name: marks[i].name, body: expandInputSchemas(src, body) });
  }
  return out;
}

describe('tenancy: every agentProcedure endpoint scopes to its agent', () => {
  const dir = routersDir();

  for (const file of ROUTER_FILES) {
    it(`${file} — no unscoped agentProcedure endpoint`, () => {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      const unscoped = agentEndpoints(src)
        .filter((e) => !SCOPING_TOKENS.some((t) => e.body.includes(t)))
        .map((e) => e.name);
      assert.deepEqual(
        unscoped,
        [],
        `${file}: agentProcedure endpoint(s) with NO agent-scoping — add an agentName/name ` +
          `input, ctx.assertAgent(loadedName), or a ctx.scopedAgent-constrained query: ${unscoped.join(', ')}`,
      );
    });
  }

  // Guard against a silently-broken parser: if the regex matched nothing, every per-file
  // check above would pass vacuously. The audit counted ~50 agentProcedure endpoints
  // across these files, so assert we actually scan many.
  it('scans a meaningful number of endpoints (no vacuous pass)', () => {
    let total = 0;
    for (const file of ROUTER_FILES) {
      total += agentEndpoints(fs.readFileSync(path.join(dir, file), 'utf8')).length;
    }
    assert.ok(total >= 25, `expected ≥25 agentProcedure endpoints scanned, got ${total}`);
  });
});
