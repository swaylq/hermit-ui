// File Station worker: pull files the dashboard stashed for THIS machine and
// write them to the chosen path (optionally unzipping). Mirrors the machine-
// request tick. Downloads stream straight to disk — never buffered whole.

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { api } from './api';
import { execCapture } from './exec';

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// If destPath is (or looks like) a directory, write `filename` into it; otherwise
// treat destPath as the full target file path.
function resolveTarget(destPathRaw: string, filename: string): { dir: string; file: string } {
  const destPath = expandHome(destPathRaw.trim());
  let isDir = destPath.endsWith('/');
  try {
    if (!isDir) isDir = fs.statSync(destPath).isDirectory();
  } catch {
    /* doesn't exist yet — treat as a file path */
  }
  if (isDir) {
    const dir = destPath.replace(/\/+$/, '') || '/';
    return { dir, file: path.join(dir, filename) };
  }
  return { dir: path.dirname(destPath), file: destPath };
}

let busy = false;

async function runOne(t: { id: string; filename: string; destPath: string; size: number; unzip: boolean }): Promise<void> {
  await api.ackFileTransfer({ id: t.id, status: 'running' }).catch(() => {});
  const isUnzip = t.unzip && /\.zip$/i.test(t.filename);

  // Stage on the SAME filesystem as the destination so the final move is an
  // atomic rename (cross-device rename throws EXDEV). For unzip, stage in tmp.
  let stagingDir: string;
  let target: { dir: string; file: string } | null = null;
  if (isUnzip) {
    stagingDir = os.tmpdir();
  } else {
    target = resolveTarget(t.destPath, t.filename);
    fs.mkdirSync(target.dir, { recursive: true });
    stagingDir = target.dir;
  }
  const staging = path.join(stagingDir, `.hermit-fs-${t.id}.part`);

  try {
    const res = await api.downloadFileTransfer(t.id);
    if (!res.body) throw new Error('下载为空');
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), fs.createWriteStream(staging));

    if (isUnzip) {
      const extractDir = expandHome(t.destPath.trim());
      fs.mkdirSync(extractDir, { recursive: true });
      const r = await execCapture('unzip', ['-o', staging, '-d', extractDir], { timeoutMs: 5 * 60_000 });
      fs.rmSync(staging, { force: true });
      if (r.status !== 0 || r.timedOut) throw new Error(`unzip 失败：${(r.stderr || r.stdout || '').slice(-200)}`);
      console.log(`[file-station] ${t.filename} → unzip → ${extractDir}`);
    } else {
      fs.renameSync(staging, target!.file);
      console.log(`[file-station] ${t.filename} → ${target!.file}`);
    }
    await api.ackFileTransfer({ id: t.id, status: 'done' });
  } catch (e) {
    try {
      fs.rmSync(staging, { force: true });
    } catch {
      /* ignore */
    }
    const msg = e instanceof Error ? e.message : String(e);
    await api.ackFileTransfer({ id: t.id, status: 'error', error: msg }).catch(() => {});
    console.error(`[file-station] ${t.filename} failed:`, msg);
  }
}

export async function fileTransferTick(): Promise<void> {
  if (busy) return; // a 300MB download can take a while — never overlap
  let pending: Awaited<ReturnType<typeof api.pollFileTransfers>>;
  try {
    pending = await api.pollFileTransfers();
  } catch (e) {
    console.error('[file-station] poll failed:', e);
    return;
  }
  if (pending.length === 0) return;
  busy = true;
  try {
    for (const t of pending) await runOne(t);
  } finally {
    busy = false;
  }
}
