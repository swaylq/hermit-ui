// market-import.ts — resolve an external URL into an importable skill. Runs
// SERVER-SIDE only (the gateway is LAN-bound; the dashboard has public egress).
// Adapters: master-skill.org (its JSON API), GitHub (raw SKILL.md), and a
// generic raw-markdown fallback. See docs/marketplace-design.md (Phase C).

export type ImportRef = { path: string; content: string };
export type ImportResult = {
  slug: string;
  displayName: string;
  description: string | null;
  content: string;                 // SKILL.md
  refs: ImportRef[];               // cli/, sub-skills/ (master.skill); [] for raw/github v1
  origin: 'github' | 'master-skill.org' | 'manual';
  originUrl: string;
};

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 512 * 1024;
const MAX_REFS = 30;

function slugify(s: string): string {
  return s.toLowerCase().replace(/\.md$/i, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'imported-skill';
}

export function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const lines = m[1].split('\n');
  const out: { name?: string; description?: string } = {};
  for (let i = 0; i < lines.length; i++) {
    const fm = lines[i].match(/^(name|description):\s*(.*)$/);
    if (!fm) continue;
    const key = fm[1] as 'name' | 'description';
    let val = fm[2];
    // YAML block scalar (`|` / `>`, optional chomp indicator): gather the indented
    // continuation lines. master.skill descriptions ship as `description: |`.
    if (/^[|>][+-]?$/.test(val.trim())) {
      const parts: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s+\S/.test(lines[j])) parts.push(lines[j].trim());
        else break;
      }
      val = parts.join(' ');
    } else {
      val = val.replace(/^["']|["']$/g, '');
    }
    out[key] = val.trim();
  }
  return out;
}

// Reject non-https + obvious internal/loopback hosts (basic SSRF guard; this is
// a single-operator tool, so we keep it simple).
function assertSafeUrl(u: URL): void {
  if (u.protocol !== 'https:') throw new Error('only https URLs are allowed');
  const h = u.hostname.toLowerCase();
  if (
    h === 'localhost' || h.endsWith('.localhost') ||
    h === '127.0.0.1' || h.startsWith('127.') ||
    h === '0.0.0.0' || h === '::1' ||
    h.startsWith('10.') || h.startsWith('192.168.') || h.startsWith('169.254.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  ) {
    throw new Error('refusing to fetch a private/loopback host');
  }
}

async function fetchText(url: string): Promise<string> {
  const u = new URL(url);
  assertSafeUrl(u);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(u.toString(), { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'hermit-ui-marketplace' } });
    if (!res.ok) throw new Error(`fetch ${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new Error(`response too large (>${Math.round(MAX_BYTES / 1024)}KB)`);
    return new TextDecoder().decode(buf);
  } finally {
    clearTimeout(timer);
  }
}

// ── master-skill.org ──────────────────────────────────────────────────────────
function masterSlug(u: URL): string | null {
  if (u.hostname !== 'master-skill.org' && u.hostname !== 'www.master-skill.org') return null;
  const m = u.pathname.match(/^\/(?:install|skill|api\/skills)\/([a-z0-9-]+)/i);
  return m ? m[1].toLowerCase() : null;
}

async function importMaster(slug: string, originUrl: string): Promise<ImportResult> {
  let content: string | null = null;
  let displayName = slug;
  let description: string | null = null;
  const refs: ImportRef[] = [];
  try {
    const raw = await fetchText(`https://master-skill.org/api/skills/${slug}`);
    const json = JSON.parse(raw);
    const cur = json?.current ?? json;
    content = cur?.skill_md ?? cur?.content ?? json?.skill_md ?? null;
    displayName = json?.title ?? json?.name ?? json?.displayName ?? slug;
    description = json?.description ?? json?.summary ?? json?.tagline
      ?? (content ? parseFrontmatter(content).description : null)
      ?? json?.name_cn ?? json?.name_en ?? null;
    // Sub-files ship inline under current.cli_scripts as { path, content } (e.g.
    // { path: 'workflow/3d.sh', … }). This previously looked for c.name — which
    // doesn't exist on the payload — so every script was silently dropped and
    // only SKILL.md imported. Keep each file at its own relative path; tolerate a
    // name-keyed object shape as a fallback.
    const cs = cur?.cli_scripts;
    if (Array.isArray(cs)) {
      for (const c of cs) {
        const p = c?.path ?? c?.name;
        if (p && c?.content != null && refs.length < MAX_REFS) refs.push({ path: String(p), content: String(c.content) });
      }
    } else if (cs && typeof cs === 'object') {
      for (const [k, v] of Object.entries(cs)) if (refs.length < MAX_REFS) refs.push({ path: String(k), content: String(v) });
    }
    if (Array.isArray(json?.sub_skills)) {
      for (const s of json.sub_skills) {
        const md = s?.skill_md ?? s?.content;
        const nm = s?.slug ?? s?.persona ?? s?.name;
        if (md && nm && refs.length < MAX_REFS) refs.push({ path: `sub-skills/${nm}/SKILL.md`, content: String(md) });
      }
    }
  } catch {
    // Fall back to the raw-markdown endpoint.
  }
  if (!content) content = await fetchText(`https://master-skill.org/api/skills/${slug}?format=markdown`);
  if (!content) throw new Error('master.skill returned no SKILL.md');
  if (!description) description = parseFrontmatter(content).description ?? null;
  return { slug, displayName, description, content, refs, origin: 'master-skill.org', originUrl };
}

// ── GitHub ────────────────────────────────────────────────────────────────────
function githubRaw(u: URL): { rawUrl: string; slug: string } | null {
  if (u.hostname === 'raw.githubusercontent.com') {
    const path = u.pathname.endsWith('.md') ? u.pathname : `${u.pathname.replace(/\/$/, '')}/SKILL.md`;
    return { rawUrl: `https://raw.githubusercontent.com${path}`, slug: slugFromPath(path) };
  }
  if (u.hostname === 'github.com' || u.hostname === 'www.github.com') {
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|tree)\/([^/]+)\/(.+)$/);
    if (m) {
      const [, owner, repo, branch, rest] = m;
      const path = rest.endsWith('.md') ? rest : `${rest.replace(/\/$/, '')}/SKILL.md`;
      return { rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`, slug: slugFromPath(path) };
    }
    const r = u.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
    if (r) return { rawUrl: `https://raw.githubusercontent.com/${r[1]}/${r[2]}/main/SKILL.md`, slug: slugify(r[2]) };
  }
  return null;
}

function slugFromPath(path: string): string {
  const parts = path.replace(/\/SKILL\.md$/i, '').split('/').filter(Boolean);
  return slugify(parts[parts.length - 1] || 'imported-skill');
}

// ── Dispatch ──────────────────────────────────────────────────────────────────
export async function resolveImport(url: string): Promise<ImportResult> {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error('invalid URL'); }
  assertSafeUrl(u);

  const ms = masterSlug(u);
  if (ms) return importMaster(ms, url);

  const gh = githubRaw(u);
  if (gh) {
    const content = await fetchText(gh.rawUrl);
    const fm = parseFrontmatter(content);
    return { slug: fm.name ? slugify(fm.name) : gh.slug, displayName: fm.name ?? gh.slug, description: fm.description ?? null, content, refs: [], origin: 'github', originUrl: url };
  }

  // Generic raw markdown.
  const content = await fetchText(url);
  const fm = parseFrontmatter(content);
  return { slug: fm.name ? slugify(fm.name) : slugFromPath(u.pathname), displayName: fm.name ?? slugFromPath(u.pathname), description: fm.description ?? null, content, refs: [], origin: 'manual', originUrl: url };
}
