// POST /api/file-station/upload — stream a large file (≤300 MB, any type incl.
// zip) to the dashboard's disk for delivery to a machine. The body is the raw
// file (NOT multipart) so it streams straight to disk without buffering. Metadata
// rides in headers (also keeps the dest path out of proxy access logs):
//   x-asst-key    machine key (scopes the transfer to that machine)
//   x-file-name   original filename (basename only)
//   x-file-path   destination path ON the machine (URL-encoded)
//   x-file-unzip  "1" to extract a zip into destPath
// The gateway then polls FileTransfer, downloads the bytes, writes them, and acks.

export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { mkdir, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { basename, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { platform } from 'node:os';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { prisma } from '@/server/db';
import { resolveKey } from '@/server/auth';

const MAX_BYTES = 300 * 1024 * 1024;

function fileStationDir(): string {
  const root = process.env.HERMIT_UPLOAD_DIR || (platform() === 'linux' ? '/var/hermit-ui/uploads' : '/tmp/hermit-ui/uploads');
  return join(root, 'file-station');
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // resolveKey accepts a machine key OR an agent share token; a scoped token may
  // only write INTO its own agent's directory (enforced once destPath is parsed).
  const scope = await resolveKey(req.headers.get('x-asst-key') || '');
  if (!scope) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const machine = scope.machine;

  let rawName = req.headers.get('x-file-name') || '';
  try {
    rawName = decodeURIComponent(rawName);
  } catch {
    /* use as-is */
  }
  const filename = basename(rawName.trim()).slice(0, 200);
  let destPath = '';
  try {
    destPath = decodeURIComponent(req.headers.get('x-file-path') || '').trim();
  } catch {
    destPath = (req.headers.get('x-file-path') || '').trim();
  }
  const unzip = req.headers.get('x-file-unzip') === '1';
  if (!filename || !destPath) return NextResponse.json({ error: '缺少文件名或目标路径' }, { status: 400 });

  // A scoped share key may only upload INTO its own agent's directory — never a
  // sibling agent or an arbitrary host path. normalize() collapses any `..`.
  if (scope.scopedAgent) {
    const agent = await prisma.agent.findUnique({
      where: { machineId_name: { machineId: machine.id, name: scope.scopedAgent } },
      select: { directory: true },
    });
    const dir = agent?.directory;
    const norm = normalize(destPath);
    if (!dir || !(norm === dir || norm.startsWith(dir.endsWith('/') ? dir : dir + '/'))) {
      return NextResponse.json({ error: 'outside the shared agent' }, { status: 403 });
    }
  }

  const declared = Number(req.headers.get('content-length') || '0');
  if (declared && declared > MAX_BYTES) return NextResponse.json({ error: '文件超过 300MB 上限' }, { status: 413 });
  if (!req.body) return NextResponse.json({ error: 'no body' }, { status: 400 });

  const dir = fileStationDir();
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `${randomUUID()}.part`);

  let received = 0;
  const cap = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (received > MAX_BYTES) return cb(new Error('文件超过 300MB 上限'));
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(req.body as Parameters<typeof Readable.fromWeb>[0]), cap, createWriteStream(tmp));
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    return NextResponse.json({ error: '上传失败：' + (e instanceof Error ? e.message : String(e)) }, { status: 400 });
  }

  // Name the stored file by the transfer id so the download route can find it.
  const ft = await prisma.fileTransfer.create({
    data: { machineId: machine.id, filename, destPath, size: received, unzip },
    select: { id: true },
  });
  try {
    await rename(tmp, join(dir, `${ft.id}.bin`));
  } catch (e) {
    await prisma.fileTransfer.update({ where: { id: ft.id }, data: { status: 'error', error: 'stash failed' } }).catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    return NextResponse.json({ error: 'stash failed: ' + (e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id: ft.id, size: received });
}
