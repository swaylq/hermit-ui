// Per-agent file manager — serves the dashboard's file browser over the
// control-channel (fs.req → fs.res). Interactive metadata ops (list / stat /
// readText / mkdir / remove / rename) run inline and reply on the same WS frame,
// so the browser feels instant. Bulk DOWNLOAD (a file, or a folder zipped with
// `zip -r`) is prepared asynchronously and streamed UP to the dashboard's ingest
// endpoint; the browser then pulls it from the dashboard stash. Uploads reuse the
// existing File Station path (dashboard stash → fileTransferTick writes to disk).
//
// Path safety: every op resolves the requested relPath under the agent's own
// directory and rejects anything that escapes it (lexical containment — the
// agent dir is the user's own workspace, same trust model as File Station).

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { DASHBOARD_URL, ASST_KEY } from './config';
import { execCapture } from './exec';

const LIST_CAP = 2000; // max entries returned per directory (node_modules guard)
const TEXT_PREVIEW_MAX = 256 * 1024; // 256 KB cap for in-browser text preview

type Entry = { name: string; type: 'dir' | 'file' | 'other'; size: number; mtimeMs: number };

// Resolve relPath under agentDir; null if it would escape (lexical). Symlinks are
// not chased — the workspace is the user's own and File Station already trusts
// the dashboard with arbitrary paths, so `..` containment is the relevant guard.
function resolveUnder(agentDir: string, relPath: string): string | null {
  const root = path.resolve(agentDir);
  const abs = path.resolve(root, relPath && relPath !== '/' ? relPath.replace(/^\/+/, '') : '.');
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function listDir(abs: string): { entries: Entry[]; truncated: boolean } {
  const names = fs.readdirSync(abs);
  const entries: Entry[] = [];
  let truncated = false;
  for (const name of names) {
    if (entries.length >= LIST_CAP) {
      truncated = true;
      break;
    }
    let st: fs.Stats;
    try {
      st = fs.lstatSync(path.join(abs, name));
    } catch {
      continue; // vanished between readdir and stat — skip
    }
    const type: Entry['type'] = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
    entries.push({ name, type, size: st.isFile() ? st.size : 0, mtimeMs: st.mtimeMs });
  }
  // Folders first, then files; each case-insensitive alphabetical.
  entries.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (b.type === 'dir' && a.type !== 'dir') return 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  return { entries, truncated };
}

export type FsResult = { ok: true; data: unknown } | { ok: false; error: string };

// Inbound { type:'fs.req', reqId, op, agentDir, relPath, ... } from the dashboard.
// Returns the payload for the matching fs.res frame.
export async function handleFsRequest(msg: {
  op?: string;
  agentDir?: string;
  relPath?: string;
  toRelPath?: string;
  downloadId?: string;
  isFolder?: boolean;
}): Promise<FsResult> {
  try {
    const op = String(msg.op || '');
    const agentDir = String(msg.agentDir || '');
    if (!agentDir) return { ok: false, error: 'no agentDir' };
    const abs = resolveUnder(agentDir, String(msg.relPath ?? ''));
    if (abs === null) return { ok: false, error: 'path escapes agent directory' };

    switch (op) {
      case 'list': {
        const st = fs.statSync(abs);
        if (!st.isDirectory()) return { ok: false, error: 'not a directory' };
        return { ok: true, data: listDir(abs) };
      }
      case 'stat': {
        const st = fs.lstatSync(abs);
        return {
          ok: true,
          data: { type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other', size: st.size, mtimeMs: st.mtimeMs },
        };
      }
      case 'readText': {
        const st = fs.statSync(abs);
        if (!st.isFile()) return { ok: false, error: 'not a file' };
        if (st.size > TEXT_PREVIEW_MAX)
          return { ok: false, error: `文件 ${(st.size / 1024 / 1024).toFixed(1)}MB 过大，仅预览 ≤256KB 文本` };
        const buf = fs.readFileSync(abs);
        if (buf.includes(0)) return { ok: false, error: '二进制文件，无法预览' };
        return { ok: true, data: { text: buf.toString('utf8'), size: st.size } };
      }
      case 'mkdir': {
        if (fs.existsSync(abs)) return { ok: false, error: '已存在同名文件/文件夹' };
        fs.mkdirSync(abs, { recursive: true });
        return { ok: true, data: {} };
      }
      case 'remove': {
        const root = path.resolve(agentDir);
        if (abs === root) return { ok: false, error: '不能删除 agent 根目录' };
        fs.rmSync(abs, { recursive: true, force: true });
        return { ok: true, data: {} };
      }
      case 'rename': {
        const target = resolveUnder(agentDir, String(msg.toRelPath ?? ''));
        if (target === null) return { ok: false, error: 'target escapes agent directory' };
        if (fs.existsSync(target)) return { ok: false, error: '目标已存在' };
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(abs, target);
        return { ok: true, data: {} };
      }
      case 'download': {
        const id = String(msg.downloadId || '');
        if (!id) return { ok: false, error: 'no downloadId' };
        // Fire-and-forget: prep + upload runs past the fs.res ack (a big zip can
        // far exceed the WS request timeout). The browser polls download status.
        void prepareDownload(id, abs, !!msg.isFolder).catch((e) =>
          console.error('[file-manager] download prep failed:', e instanceof Error ? e.message : e),
        );
        return { ok: true, data: { started: true } };
      }
      default:
        return { ok: false, error: `unknown op: ${op}` };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Prepare a download: for a file, stream it as-is; for a folder, `zip -r` to a
// temp archive first. Then POST the bytes up to the dashboard ingest endpoint,
// which stashes them for the browser to pull. On any failure, tell the dashboard
// so the browser stops polling.
async function prepareDownload(id: string, abs: string, isFolder: boolean): Promise<void> {
  let sendPath = abs;
  let filename = path.basename(abs);
  let cleanup: string | null = null;
  try {
    if (isFolder) {
      const zipPath = path.join(os.tmpdir(), `hermit-dl-${id}.zip`);
      const parent = path.dirname(abs);
      const base = path.basename(abs);
      // -q quiet (no per-file stdout to buffer), -r recursive; run from the parent
      // so the archive holds <base>/… not absolute paths.
      const r = await execCapture('zip', ['-r', '-q', zipPath, base], { cwd: parent, timeoutMs: 10 * 60_000 });
      if (r.status !== 0 || r.timedOut) throw new Error(`zip 失败：${(r.stderr || r.stdout || '').slice(-200)}`);
      sendPath = zipPath;
      filename = `${base}.zip`;
      cleanup = zipPath;
    }
    const size = fs.statSync(sendPath).size;
    const res = await fetch(`${DASHBOARD_URL}/api/file-manager/ingest/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: {
        'x-asst-key': ASST_KEY,
        'content-type': 'application/octet-stream',
        'x-file-name': encodeURIComponent(filename),
        'x-file-size': String(size),
      },
      body: Readable.toWeb(createReadStream(sendPath)) as unknown as ReadableStream,
      // undici requires duplex:'half' for a streaming request body.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    if (!res.ok) throw new Error(`ingest → ${res.status}`);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // Best-effort failure signal so the browser's poll resolves to an error.
    await fetch(`${DASHBOARD_URL}/api/file-manager/ingest/${encodeURIComponent(id)}?error=1`, {
      method: 'POST',
      headers: { 'x-asst-key': ASST_KEY, 'content-type': 'application/json', 'x-file-error': encodeURIComponent(error.slice(0, 200)) },
    }).catch(() => {});
    throw e;
  } finally {
    if (cleanup) {
      try {
        fs.rmSync(cleanup, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
