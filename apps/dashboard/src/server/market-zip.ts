// Read/write skill packages as .zip — the file half of market upload/download.
//
// A skill package is a folder tree rooted at a SKILL.md: the SKILL.md body
// becomes MarketSkillVersion.content, every other file becomes a ref
// ({ path, content }) keyed by its path relative to the SKILL.md's directory.
// This is the exact shape publishSkillFromLocal / commitImport already store,
// so upload needs no schema change and download round-trips losslessly.
//
// Guards (this parses untrusted archives, and refs later get written to disk
// when a skill is installed onto an agent — see installToAgent):
//   - reject ../ and absolute paths (zip-slip)
//   - cap file count + per-file + total uncompressed size (zip-bomb)
//   - skip binary files (the refs model is text-only)

import JSZip from 'jszip';
import { parseFrontmatter } from './market-import';

const MAX_FILES = 200;
const MAX_PER_FILE = 4 * 1024 * 1024; // 4 MB
const MAX_TOTAL = 20 * 1024 * 1024; // 20 MB uncompressed

export type SkillRef = { path: string; content: string };

export type ParsedSkill = {
  slug: string; // derived (frontmatter name / folder); caller validates against SLUG_RE
  displayName: string;
  description: string | null;
  content: string; // SKILL.md
  refs: SkillRef[];
  fileCount: number; // 1 (SKILL.md) + refs.length
  folderName: string | null; // top folder the SKILL.md sat in, if any
  skipped: string[]; // files dropped (binary / unsafe path / too large), for the UI
};

// macOS / Windows archive cruft that should never become a ref.
function isJunk(name: string): boolean {
  if (name.startsWith('__MACOSX/') || name.includes('/__MACOSX/')) return true;
  const base = name.split('/').pop() || '';
  return base === '.DS_Store' || base === 'Thumbs.db' || base === '';
}

// Heuristic: a NUL byte in the first 8 KB ⇒ treat as binary (skip it).
function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

function unsafePath(rel: string): boolean {
  return rel.startsWith('/') || rel.split('/').some((s) => s === '..');
}

export async function parseSkillZip(data: ArrayBuffer | Uint8Array): Promise<ParsedSkill> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new Error('not a valid .zip archive');
  }

  const files = Object.values(zip.files).filter((f) => !f.dir && !isJunk(f.name));
  if (files.length === 0) throw new Error('archive is empty');
  if (files.length > MAX_FILES) throw new Error(`too many files in archive (${files.length} > ${MAX_FILES})`);

  // The shallowest SKILL.md is the skill root; its directory is the prefix that
  // all refs are relative to. Nested SKILL.md files (sub-skills) stay as refs.
  const skillMds = files
    .filter((f) => (f.name.split('/').pop() || '') === 'SKILL.md')
    .sort((a, b) => a.name.split('/').length - b.name.split('/').length);
  if (skillMds.length === 0) throw new Error('no SKILL.md found in the archive');
  const skillMd = skillMds[0];
  const segs = skillMd.name.split('/');
  const rootPrefix = segs.length > 1 ? segs.slice(0, -1).join('/') + '/' : '';
  const folderName = segs.length > 1 ? segs[segs.length - 2] : null;

  let total = 0;
  const skipped: string[] = [];
  async function readText(f: JSZip.JSZipObject): Promise<string | null> {
    const bytes = await f.async('uint8array');
    if (bytes.length > MAX_PER_FILE) {
      skipped.push(`${f.name} (too large)`);
      return null;
    }
    total += bytes.length;
    if (total > MAX_TOTAL) throw new Error('archive contents too large (zip-bomb guard)');
    if (looksBinary(bytes)) {
      skipped.push(`${f.name} (binary)`);
      return null;
    }
    return new TextDecoder('utf-8').decode(bytes);
  }

  const content = await readText(skillMd);
  if (content == null) throw new Error('SKILL.md is binary or too large');

  const refs: SkillRef[] = [];
  for (const f of files) {
    if (f === skillMd) continue;
    if (rootPrefix && !f.name.startsWith(rootPrefix)) continue; // outside the skill folder
    const rel = rootPrefix ? f.name.slice(rootPrefix.length) : f.name;
    if (!rel) continue;
    if (unsafePath(rel)) {
      skipped.push(`${f.name} (unsafe path)`);
      continue;
    }
    const text = await readText(f);
    if (text == null) continue;
    refs.push({ path: rel, content: text });
  }

  const fm = parseFrontmatter(content);
  const slug = (fm.name || folderName || '').toLowerCase().trim();
  const displayName = fm.name || folderName || slug;

  return {
    slug,
    displayName,
    description: fm.description ?? null,
    content,
    refs,
    fileCount: 1 + refs.length,
    folderName,
    skipped,
  };
}

// Pack a skill version back into a .zip rooted at <slug>/ (SKILL.md + refs).
export async function buildSkillZip(args: { slug: string; content: string; refs: SkillRef[] }): Promise<Buffer> {
  const zip = new JSZip();
  const folder = zip.folder(args.slug) ?? zip;
  folder.file('SKILL.md', args.content);
  for (const r of args.refs) {
    if (!r.path || unsafePath(r.path)) continue; // defensive — never emit traversal paths
    folder.file(r.path, r.content ?? '');
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
