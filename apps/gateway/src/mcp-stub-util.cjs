// @ts-check
// Pure, dependency-free helpers extracted from mcp-stub.cjs so they can be
// type-checked (// @ts-check — the .cjs stub itself is spawned by raw `node` and
// stays outside the tsc gate) AND unit-tested in isolation. No env, no network, no
// stdio — just data transforms. Node-builtins-only, CommonJS, required by the stub
// via a relative path (ships with the same git pull). The stub's dynamic JSON-RPC
// transport / tRPC client / tool dispatchers deliberately stay in mcp-stub.cjs.
'use strict';

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

module.exports = { MIME_BY_EXT, mimeForExt, textOf, buildCronPatch };
