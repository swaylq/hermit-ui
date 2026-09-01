// @ts-check
// Pure, dependency-free helpers extracted from mcp-stub.cjs so they can be
// type-checked (// @ts-check — the .cjs stub itself is spawned by raw `node` and
// stays outside the tsc gate) AND unit-tested in isolation. No env, no network, no
// stdio — just data transforms. Node-builtins-only, CommonJS, required by the stub
// via a relative path (ships with the same git pull). The stub's dynamic JSON-RPC
// transport / tRPC client / tool dispatchers deliberately stay in mcp-stub.cjs.
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  // office docs (so the download chip carries a correct content-type)
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
};

/**
 * MIME type for a bare, lower-cased file extension (no leading dot). Images upload
 * with their real MIME so /api/upload runs the image path; everything unknown falls
 * back to octet-stream (then the upload route validates against its own allowlist).
 * @param {string} ext - bare extension, e.g. "png" (already lower-cased, dot-stripped)
 * @returns {string}
 */
function mimeForExt(ext) {
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/**
 * Flatten Anthropic content blocks to plain text (drops tool_use / tool_result /
 * image blocks) — used to summarize an agent's last turn for the brain tools.
 * Accepts a raw string, an array of content blocks, or anything else (→ '').
 * @param {unknown} content
 * @returns {string}
 */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Normalize cron_update's tool args into the tRPC patch: minutes in (what the model
 * reasons about) → seconds out (what the DB stores). Only fields the caller actually
 * passed come back, so editing a prompt never silently rewrites the interval — and an
 * args object with nothing to change THROWS rather than sending an empty patch, which
 * would report success while doing nothing. `id`/`sessionId` are the caller's to add.
 * @param {any} args
 * @returns {{prompt?: string, title?: string, intervalSec?: number, jitterSec?: number, enabled?: boolean}}
 */
function buildCronPatch(args) {
  /** @type {{prompt?: string, title?: string, intervalSec?: number, jitterSec?: number, enabled?: boolean}} */
  const patch = {};
  if (typeof args?.prompt === 'string' && args.prompt.trim()) patch.prompt = args.prompt.trim();
  if (typeof args?.title === 'string' && args.title.trim()) patch.title = args.title.trim().slice(0, 120);
  if (args?.intervalMinutes != null) {
    const m = Number(args.intervalMinutes);
    if (!Number.isFinite(m) || m < 1) throw new Error('intervalMinutes must be ≥ 1');
    patch.intervalSec = Math.round(m * 60);
  }
  if (args?.jitterMinutes != null) {
    const j = Number(args.jitterMinutes);
    if (!Number.isFinite(j) || j < 0) throw new Error('jitterMinutes must be ≥ 0');
    patch.jitterSec = Math.round(j * 60);
  }
  if (typeof args?.enabled === 'boolean') patch.enabled = args.enabled;
  if (Object.keys(patch).length === 0) {
    throw new Error(
      'nothing to update — pass at least one of prompt/title/intervalMinutes/jitterMinutes/enabled',
    );
  }
  return patch;
}

// ── memory_write's path gate ────────────────────────────────────────────────
// A pure-chat session has no Write and no shell, on purpose. But an agent that
// cannot record what it just worked out is an agent that forgets the
// conversation the moment it ends, so it gets exactly one narrow way to put
// something on disk — and this function is the whole of that narrowness.
//
// Treat it as a security boundary, not a convenience helper: it is the only
// thing standing between "read-only session" and "arbitrary file write".

/** Directory prefixes a pure-chat session may write inside. */
const MEMORY_WRITE_PREFIXES = ['memory/', 'evolution/'];
/** Individual files it may write, outside those directories. */
const MEMORY_WRITE_FILES = ['MEMORY.md'];

/**
 * Validate a memory-write target and return it as an absolute path.
 *
 * Rejects, in this order: non-strings, absolute paths, NUL bytes, anything that
 * escapes the agent directory once resolved (which is what stops `../`, however
 * it is spelled or repeated), anything outside the memory allowlist, and any
 * extension other than .md.
 *
 * The .md rule is not about tidiness: a pure-chat session cannot run what it
 * writes, but a LATER ordinary session in the same directory can, and "drop a
 * shell script into memory/ now, have it run next week" should not be reachable
 * from a mode whose entire promise is that nothing changes.
 *
 * Symlink escape is checked by the caller, which has the filesystem; everything
 * here is pure so it can be tested exhaustively.
 *
 * @param {string} agentDir - absolute path to the agent's own directory
 * @param {string} rel - caller-supplied path, relative to that directory
 * @returns {string} absolute path to write
 */
function resolveMemoryPath(agentDir, rel) {
  if (typeof rel !== 'string' || !rel.trim()) throw new Error('path required');
  if (rel.includes('\0')) throw new Error('path must not contain a NUL byte');
  if (path.isAbsolute(rel)) throw new Error(`path must be relative to the agent directory: ${rel}`);

  const base = path.resolve(agentDir);
  const abs = path.resolve(base, rel);
  // The separator matters: without it, /agents/asst-backup would pass as being
  // inside /agents/asst.
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`path escapes the agent directory: ${rel}`);
  }

  // Compare on the RESOLVED path, not the caller's string: "memory/../x.md" and
  // "memory/./notes/y.md" both have to be judged by where they actually land.
  const inside = abs.slice(base.length + 1);
  const posix = inside.split(path.sep).join('/');
  const allowed =
    MEMORY_WRITE_FILES.includes(posix) ||
    MEMORY_WRITE_PREFIXES.some((pre) => posix.startsWith(pre) && posix.length > pre.length);
  if (!allowed) {
    throw new Error(
      `pure-chat sessions may only write memory: ${MEMORY_WRITE_PREFIXES.join(', ')} or ${MEMORY_WRITE_FILES.join(', ')} (got ${posix || rel})`,
    );
  }
  if (!posix.toLowerCase().endsWith('.md')) throw new Error(`memory files are markdown: ${posix}`);
  return abs;
}

/**
 * Perform a pure-chat memory write. Shared by BOTH surfaces that offer it — the
 * MCP stub (claude x2, codex) and the pi extension (pi, omp, prime) — so the
 * rule about what may be written has exactly one implementation, and the tests
 * below cover it once for everyone.
 *
 * No mode can destroy existing text: `append` and `prepend` keep it, `create`
 * refuses a file that is already there. That is the property that makes a write
 * tool acceptable inside a mode whose promise is "nothing changes".
 *
 * @param {string} agentDir
 * @param {{path?: unknown, content?: unknown, mode?: unknown}} args
 * @returns {string} a human-readable confirmation
 */
function writeMemory(agentDir, args) {
  if (!agentDir) throw new Error('agent directory unknown — the gateway did not pass HERMIT_AGENT_DIR');
  const content = args && args.content;
  if (typeof content !== 'string' || !content) throw new Error('content required');
  const mode = (args && args.mode) || 'append';
  if (!['append', 'prepend', 'create'].includes(mode)) throw new Error(`unknown mode: ${mode}`);

  const rel = args && args.path;
  const abs = resolveMemoryPath(agentDir, /** @type {string} */ (rel));

  // The string gate cannot see a symlink. Resolve the deepest ancestor that
  // exists and check THAT: a symlinked memory/ would otherwise let a path which
  // looks entirely clean land anywhere on the disk.
  const base = fs.realpathSync(agentDir);
  let probe = path.dirname(abs);
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  const realProbe = fs.realpathSync(probe);
  if (realProbe !== base && !realProbe.startsWith(base + path.sep)) {
    throw new Error('path leaves the agent directory through a symlink');
  }
  const existed = fs.existsSync(abs);
  if (existed && !fs.realpathSync(abs).startsWith(base + path.sep)) {
    throw new Error('that file is a symlink pointing out of the agent directory');
  }
  if (mode === 'create' && existed) {
    throw new Error(`${rel} already exists — use append or prepend, which keep what is there`);
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (mode === 'prepend') fs.writeFileSync(abs, content + (existed ? fs.readFileSync(abs, 'utf8') : ''));
  else if (mode === 'create') fs.writeFileSync(abs, content);
  else fs.appendFileSync(abs, content);

  const verb = mode === 'append' ? 'appended to' : mode === 'prepend' ? 'prepended to' : 'created';
  return `ok — ${verb} ${rel} (${Buffer.byteLength(content)} bytes)`;
}

module.exports = { MIME_BY_EXT, mimeForExt, textOf, buildCronPatch, resolveMemoryPath, writeMemory, MEMORY_WRITE_PREFIXES, MEMORY_WRITE_FILES };
