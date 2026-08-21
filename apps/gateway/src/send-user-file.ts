// Claude Code's own `SendUserFile`, delivered where the user is actually looking.
//
// Claude Code ships a first-party file-delivery tool, and enables it whenever a
// Remote Control bridge is attached to the session (the `bridge-session` record
// at the head of the transcript). Its upload lane is Anthropic's: the bytes go
// to the bridge store and render as a card in the phone/web Remote Control
// view — and NOWHERE else. A dashboard session is driven by a local `claude`,
// so on any machine whose sessions are bridged the tool is enabled, fully
// loaded, and sitting right next to the model. hermit's own `attach_file` is an
// MCP tool, which the harness defers to a name-only stub the model must spend a
// ToolSearch call to open. Between a native tool that is already loaded and a
// deferred one that is not, the model reaches for the native one, gets back
// "2 files delivered to user.", and reports the job done.
//
// The dashboard shows nothing. It has no notion of this tool, and the `tool_use`
// row folds into a run capsule on the way in (fold-runs.ts keeps only
// text / image / file / interaction out of the fold), so there is not even a
// hint that a file was meant to arrive. That is how a 41-page deliverable went
// missing on 2026-08-21: the agent was certain it had sent it, and the person it
// was for saw one collapsed capsule.
//
// So: every outbound row is scanned for a SendUserFile call, and each file it
// names is uploaded through hermit's own /api/upload and posted as the same
// `file` / `image` blocks `attach_file` posts. The native tool keeps working —
// this only adds the copy that lands in the dashboard.
//
// Two properties this has to hold:
//
//   * ONE row per call, forever. `watchTranscript` replays the whole JSONL from
//     line 1 on every gateway restart, so the same tool_use is re-seen for the
//     life of the session. The row's externalId is derived from the tool_use id
//     — globally unique, stable across a resume and across a tmux↔sdk migration
//     — so a replay upserts onto the row it already wrote (see
//     claude-sdk-events.ts on why that equivalence is load-bearing).
//
//   * BYTES uploaded at most once. The externalId keeps the ROW single, but a
//     replay would still re-POST the file: a 14 MB pptx re-uploaded on every
//     gateway restart, for every live session that ever sent one. A marker under
//     ~/.hermit/sent-files/ makes the upload skip when we already did it. It is
//     deliberately NOT the row's source of truth — a marker lost (fresh machine,
//     pruned directory) costs one re-upload, never a duplicate row.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DASHBOARD_URL, ASST_KEY } from './config';
import { api } from './api';
import type { SyncItem } from './runtime/types';

/** The tool name Claude Code uses. Not ours — matched, never emitted. */
export const SEND_USER_FILE_TOOL = 'SendUserFile';

export type SendUserFileCall = {
  toolUseId: string;
  files: string[];
  /** Empty string when the model sent none. */
  caption: string;
  /** 'render' = inline in the side panel, 'attach' = download card only, null = client decides. */
  display: 'render' | 'attach' | null;
};

/** What /api/upload answers with. Same shape mcp-stub.cjs's uploadFile returns. */
export type UploadedFile = {
  url: string;
  mimeType: string;
  kind: string | null;
  name: string;
  width: number | null;
  height: number | null;
};

export type FileOutcome =
  | { ok: true; path: string; upload: UploadedFile }
  | { ok: false; path: string; reason: string };

// ── Pure: reading the call out of a message ──────────────────────────────────

// The tool's schema preprocesses a bare string into a one-element array, so both
// shapes reach the transcript depending on how the model called it.
function asFileList(v: unknown): string[] {
  const raw = typeof v === 'string' ? [v] : Array.isArray(v) ? v : [];
  return raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

/**
 * Every SendUserFile call in one message's content, in order.
 *
 * A call with no id or no files is dropped rather than guessed at: the id is the
 * dedup key and without it a replay would post a second row every restart.
 */
export function sendUserFileCalls(content: unknown): SendUserFileCall[] {
  if (!Array.isArray(content)) return [];
  const calls: SendUserFileCall[] = [];
  for (const raw of content) {
    const block = raw as { type?: unknown; name?: unknown; id?: unknown; input?: unknown } | null;
    if (!block || typeof block !== 'object') continue;
    if (block.type !== 'tool_use' || block.name !== SEND_USER_FILE_TOOL) continue;

    const toolUseId = typeof block.id === 'string' ? block.id : '';
    const input = (block.input ?? {}) as { files?: unknown; caption?: unknown; display?: unknown };
    const files = asFileList(input.files);
    if (!toolUseId || files.length === 0) continue;

    calls.push({
      toolUseId,
      files,
      caption: typeof input.caption === 'string' ? input.caption.trim() : '',
      display: input.display === 'render' || input.display === 'attach' ? input.display : null,
    });
  }
  return calls;
}

/** The upsert key. Derived from the tool_use id so a replay lands on its own row. */
export function deliveryExternalId(toolUseId: string): string {
  return `sent-file-${toolUseId}`;
}

/**
 * The blocks that become the dashboard row — the same vocabulary `attach_file`
 * and `attach_image` post, because those already render correctly and are
 * already exempt from run folding.
 *
 * A failed file is NOT silently dropped. Silence is the whole bug this module
 * exists to fix, and a file that could not be uploaded is still sitting on the
 * machine where the user can be told to go get it.
 */
export function blocksFor(call: SendUserFileCall, outcomes: FileOutcome[]): unknown[] {
  const blocks: unknown[] = [];
  if (call.caption) blocks.push({ type: 'text', text: call.caption });

  for (const o of outcomes) {
    if (!o.ok) continue;
    // Images render inline unless the model explicitly asked for a download card.
    const inline = o.upload.kind === 'image' && call.display !== 'attach';
    if (inline) {
      blocks.push({
        type: 'image',
        source: { type: 'url', url: o.upload.url, media_type: o.upload.mimeType },
        ...(typeof o.upload.width === 'number' && typeof o.upload.height === 'number'
          ? { width: o.upload.width, height: o.upload.height }
          : {}),
      });
    } else {
      blocks.push({
        type: 'file',
        source: { type: 'url', url: o.upload.url, media_type: o.upload.mimeType || 'application/octet-stream' },
        name: o.upload.name,
      });
    }
  }

  const failed = outcomes.filter((o): o is Extract<FileOutcome, { ok: false }> => !o.ok);
  if (failed.length > 0) {
    blocks.push({
      type: 'text',
      text:
        `[gateway] ⚠️ ${failed.length} 个文件没能贴进对话（文件仍在这台机器上）：\n` +
        failed.map((f) => `- \`${f.path}\` — ${f.reason}`).join('\n'),
    });
  }
  return blocks;
}

// ── Effects ──────────────────────────────────────────────────────────────────

const MARKER_DIR = path.join(os.homedir(), '.hermit', 'sent-files');
// Anthropic tool_use ids are `toolu_<base62>`. Anything else does not become a
// filename — a marker is an optimisation, not a correctness boundary.
const SAFE_TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function markerPath(toolUseId: string): string | null {
  return SAFE_TOOL_USE_ID.test(toolUseId) ? path.join(MARKER_DIR, `${toolUseId}.json`) : null;
}

function alreadySent(toolUseId: string): boolean {
  const p = markerPath(toolUseId);
  if (!p) return false;
  try { return fs.existsSync(p); } catch { return false; }
}

function markSent(toolUseId: string, note: Record<string, unknown>): void {
  const p = markerPath(toolUseId);
  if (!p) return;
  try {
    fs.mkdirSync(MARKER_DIR, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(note));
  } catch (e) {
    // A marker we could not write costs a re-upload on the next replay, nothing
    // more — the externalId still collapses it onto the same row.
    console.warn('[sent-file] marker write failed:', e);
  }
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp',
};

/**
 * Upload one file to the dashboard. Mirrors mcp-stub.cjs's uploadFile: images go
 * up with their real MIME so /api/upload runs its image path (the ≤2000px
 * `.safe.` sidecar that stops an oversized image from wedging a session);
 * everything else uploads as octet-stream and the route validates the extension
 * against its own allowlist.
 */
async function uploadToDashboard(filePath: string, sessionId: string): Promise<UploadedFile> {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('not a regular file');
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  const body = new FormData();
  body.append('sessionId', sessionId);
  body.append(
    'file',
    new Blob([fs.readFileSync(filePath)], { type: IMAGE_MIME[ext] ?? 'application/octet-stream' }),
    path.basename(filePath),
  );
  const r = await fetch(`${DASHBOARD_URL}/api/upload`, {
    method: 'POST',
    headers: { 'x-asst-key': ASST_KEY },
    body,
  });
  if (!r.ok) {
    const detail = (await r.text().catch(() => '')).slice(0, 200);
    throw new Error(r.status === 415 ? `这种文件类型不允许上传（${ext || '无扩展名'}）` : `上传失败 ${r.status}${detail ? `: ${detail}` : ''}`);
  }
  const j = (await r.json()) as Record<string, unknown>;
  return {
    url: String(j.url ?? ''),
    mimeType: typeof j.mimeType === 'string' ? j.mimeType : '',
    kind: typeof j.kind === 'string' ? j.kind : null,
    name: typeof j.name === 'string' && j.name ? j.name : path.basename(filePath),
    width: typeof j.width === 'number' ? j.width : null,
    height: typeof j.height === 'number' ? j.height : null,
  };
}

export type SendUserFileDeps = {
  upload(filePath: string, sessionId: string): Promise<UploadedFile>;
  post(items: SyncItem[]): Promise<unknown>;
  alreadySent(toolUseId: string): boolean;
  markSent(toolUseId: string, note: Record<string, unknown>): void;
  now(): number;
};

export const REAL_DEPS: SendUserFileDeps = {
  upload: uploadToDashboard,
  post: (items) => api.syncChatMessages(items),
  alreadySent,
  markSent,
  now: () => Date.now(),
};

function reasonOf(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('ENOENT')) return '文件已不在磁盘上';
  return msg.slice(0, 160);
}

/**
 * Upload one call's files and post the row. Returns whether a row was written.
 *
 * The marker is only stamped when at least one file made it: a call that failed
 * wholesale (dashboard down, disk hiccup) is worth retrying on the next replay,
 * and because the externalId is stable, the retry rewrites the same row rather
 * than adding one.
 */
export async function deliverSendUserFile(
  sessionId: string,
  call: SendUserFileCall,
  deps: SendUserFileDeps = REAL_DEPS,
): Promise<boolean> {
  if (deps.alreadySent(call.toolUseId)) return false;

  const outcomes: FileOutcome[] = [];
  for (const p of call.files) {
    try {
      outcomes.push({ ok: true, path: p, upload: await deps.upload(p, sessionId) });
    } catch (e) {
      outcomes.push({ ok: false, path: p, reason: reasonOf(e) });
    }
  }

  const blocks = blocksFor(call, outcomes);
  if (blocks.length === 0) return false;

  await deps.post([
    {
      sessionId,
      role: 'assistant',
      content: blocks,
      externalId: deliveryExternalId(call.toolUseId),
      claudeSessionId: null,
    },
  ]);

  const delivered = outcomes.filter((o) => o.ok).length;
  if (delivered > 0) {
    deps.markSent(call.toolUseId, {
      sessionId,
      at: deps.now(),
      files: outcomes.filter((o): o is Extract<FileOutcome, { ok: true }> => o.ok).map((o) => o.upload.url),
    });
  }
  return true;
}

/**
 * The hook chat-runner calls for every outbound row. Fire-and-forget by design:
 * an upload takes as long as the file is big, and the sync path it hangs off is
 * a synchronous buffer fill that must not wait on the network.
 */
// Calls whose upload is in flight. The marker only exists once the row is
// posted, and a big file takes seconds to go up — long enough for a second sight
// of the same tool_use (an SDK stream and its JSONL backstop, a replay landing
// mid-upload) to start a duplicate upload that the marker cannot yet veto.
const inFlight = new Set<string>();

export function noteOutboundSync(item: SyncItem, deps: SendUserFileDeps = REAL_DEPS): void {
  // `transient` rows are streaming previews — a tool_use in one may still be
  // half-parsed, and acting on a truncated file list would deliver the wrong
  // thing. The finished row always follows.
  if (item.transient || item.deleted) return;
  if (item.role !== 'assistant') return;

  for (const call of sendUserFileCalls(item.content)) {
    if (inFlight.has(call.toolUseId) || deps.alreadySent(call.toolUseId)) continue;
    inFlight.add(call.toolUseId);
    void deliverSendUserFile(item.sessionId, call, deps)
      .catch((e) => {
        console.error(`[sent-file] ${call.toolUseId} failed to reach the dashboard:`, e);
      })
      .finally(() => inFlight.delete(call.toolUseId));
  }
}
