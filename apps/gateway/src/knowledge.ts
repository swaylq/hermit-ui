// knowledge.ts — materialize per-agent knowledge bases as Claude Code skills under
// <agent>/.claude/skills/kb-<slug>/ (intro → SKILL.md description, docs read on
// demand). DB is the source of truth; the dashboard enqueues KnowledgeBaseRequest
// rows, we poll/apply/ack (mirrors global-skills). A startup reconcile converges
// disk to DB and prunes orphan kb-* dirs. See docs/knowledge-base-design.md.

import fs from 'node:fs';
import path from 'node:path';
import { api } from './api';

interface KbDoc {
  filename: string;
  title: string;
  content: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;

function kbDir(agentDir: string, slug: string): string {
  return path.join(agentDir, '.claude', 'skills', `kb-${slug}`);
}

// The SKILL.md: `description` is the always-loaded intro; `hermit_kind` marks it so
// skill collectors skip it; the body is a document index the agent reads on demand.
function renderSkillMd(name: string, intro: string, docs: KbDoc[]): string {
  const description = (intro || '').replace(/\r?\n+/g, ' ').trim() || `Knowledge base: ${name}`;
  const index = docs.length
    ? docs.map((d) => `- \`docs/${d.filename}\` — ${d.title}`).join('\n')
    : '- (no documents yet)';
  return `---
name: ${name}
description: ${JSON.stringify(description)}
hermit_kind: knowledge
---
# ${name}

Consult this knowledge base when relevant. Read the specific document below rather
than answering from memory.

Documents:
${index}
`;
}

// A dir is a materialized KB (vs a human skill that happens to be named kb-*) iff
// its SKILL.md carries the hermit_kind: knowledge marker. Used to keep the orphan
// pruner from ever deleting a real user skill.
function isKnowledgeDir(dir: string): boolean {
  try {
    const head = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').slice(0, 2048);
    const fm = head.match(/^---\n([\s\S]*?)\n---/);
    return !!fm && /(^|\n)hermit_kind:\s*knowledge\s*(\r?\n|$)/.test(fm[1]);
  } catch {
    return false;
  }
}

// Write kb-<slug>/{SKILL.md, docs/*.md} from a snapshot; prune stale doc files.
// Idempotent. filenames are slugified server-side; guard traversal defensively.
export function materializeKb(agentDir: string, slug: string, name: string, intro: string, docs: KbDoc[]): void {
  if (!SLUG_RE.test(slug)) throw new Error(`invalid kb slug: ${slug}`);
  const dir = kbDir(agentDir, slug);
  const docsDir = path.join(dir, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), renderSkillMd(name, intro, docs));
  const keep = new Set<string>();
  for (const d of docs) {
    if (typeof d?.filename !== 'string' || typeof d?.content !== 'string') continue;
    if (d.filename.includes('/') || d.filename.includes('..')) continue;
    fs.writeFileSync(path.join(docsDir, d.filename), d.content);
    keep.add(d.filename);
  }
  try {
    for (const f of fs.readdirSync(docsDir)) {
      if (!keep.has(f)) fs.rmSync(path.join(docsDir, f), { recursive: true, force: true });
    }
  } catch {
    /* docs dir just created / empty */
  }
}

export function removeKb(agentDir: string, slug: string): void {
  if (!SLUG_RE.test(slug)) return;
  fs.rmSync(kbDir(agentDir, slug), { recursive: true, force: true });
}

interface KbRequest {
  id: string;
  agentName: string;
  slug: string;
  kind: string;
  payload: { name?: string; intro?: string; docs?: KbDoc[] } | null;
  agentDirectory: string | null;
}

function applyKnowledgeRequest(req: KbRequest): void {
  if (!req.agentDirectory) throw new Error(`agent "${req.agentName}" has no directory`);
  if (req.kind === 'materialize') {
    const p = req.payload ?? {};
    materializeKb(req.agentDirectory, req.slug, p.name ?? req.slug, p.intro ?? '', Array.isArray(p.docs) ? p.docs : []);
  } else if (req.kind === 'remove') {
    removeKb(req.agentDirectory, req.slug);
  } else {
    throw new Error(`unknown kind: ${req.kind}`);
  }
}

let busy = false;
export async function knowledgeRequestTick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const reqs = await api.pollKnowledgeRequests();
    for (const r of reqs) {
      try {
        applyKnowledgeRequest(r);
        await api.ackKnowledgeRequest({ id: r.id, status: 'done' });
      } catch (e) {
        await api.ackKnowledgeRequest({ id: r.id, status: 'error', error: String((e as Error)?.message ?? e) });
      }
    }
  } finally {
    busy = false;
  }
}

// Per-dir marker recording the contentUpdatedAt we last materialized. Lives at the
// kb-<slug> root (never inside docs/, so materializeKb's doc-pruning leaves it
// alone; and it's a dotfile, not a SKILL.md, so skill collectors ignore it).
function markerPath(agentDir: string, slug: string): string {
  return path.join(kbDir(agentDir, slug), '.materialized-at');
}
// contentUpdatedAt bumps on every KB content change, so a marker that still matches
// means the on-disk KB is current — skip re-materializing it. A missing/half-written
// dir (no SKILL.md) or a missing marker (older / incremental write) refreshes once.
function kbUpToDate(agentDir: string, slug: string, contentUpdatedAt: string): boolean {
  if (!fs.existsSync(path.join(kbDir(agentDir, slug), 'SKILL.md'))) return false;
  try {
    return fs.readFileSync(markerPath(agentDir, slug), 'utf8').trim() === contentUpdatedAt;
  } catch {
    return false;
  }
}
function writeKbMarker(agentDir: string, slug: string, contentUpdatedAt: string): void {
  try {
    fs.writeFileSync(markerPath(agentDir, slug), contentUpdatedAt);
  } catch {
    /* best-effort — a missing marker just refreshes on the next reconcile */
  }
}

// Startup convergence (once, not per-tick): materialize attachments DB→disk, then
// prune orphan kb-* dirs the DB no longer lists (only dirs carrying the hermit_kind
// marker — never a human skill named kb-*). To avoid re-shipping every base's full
// markdown on every restart (P3-1), fetch the lightweight manifest first and only
// pull + rewrite the bases whose contentUpdatedAt changed since the on-disk marker;
// ALL attached slugs still count as valid for the pruner. (An incremental edit
// doesn't touch the marker, so an edited base refreshes once on the next restart —
// harmless, materializeKb is idempotent.)
export async function reconcileKnowledgeOnStartup(): Promise<void> {
  const manifest = await api.listKnowledgeManifest();
  const validByDir = new Map<string, Set<string>>();
  const changed: Array<{ agentName: string; slug: string }> = [];
  for (const it of manifest) {
    if (!it.agentDirectory) continue;
    if (!validByDir.has(it.agentDirectory)) validByDir.set(it.agentDirectory, new Set());
    validByDir.get(it.agentDirectory)!.add(it.slug); // every attached slug stays valid for the pruner
    if (!kbUpToDate(it.agentDirectory, it.slug, it.contentUpdatedAt)) changed.push({ agentName: it.agentName, slug: it.slug });
  }
  if (changed.length) {
    const items = await api.listKnowledgeMaterialization(changed);
    for (const it of items) {
      if (!it.agentDirectory) continue;
      try {
        materializeKb(it.agentDirectory, it.slug, it.name, it.intro, it.docs);
        writeKbMarker(it.agentDirectory, it.slug, it.contentUpdatedAt);
      } catch (e) {
        console.error(`[knowledge] reconcile ${it.agentName}/${it.slug}:`, e instanceof Error ? e.message : e);
      }
    }
  }
  console.log(`[knowledge] reconcile: ${manifest.length} attached, ${changed.length} (re)materialized, ${manifest.length - changed.length} unchanged`);
  const agents = await api.listAgentDirectories();
  for (const a of agents) {
    if (!a.directory) continue;
    const skillsDir = path.join(a.directory, '.claude', 'skills');
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const valid = validByDir.get(a.directory) ?? new Set<string>();
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith('kb-')) continue;
      const dir = path.join(skillsDir, e.name);
      if (!isKnowledgeDir(dir)) continue; // leave real user skills alone
      if (!valid.has(e.name.slice(3))) fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
