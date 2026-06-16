// POST /api/file-manager/ingest/<id> — the gateway streams a prepared download
// (a file, or a zipped folder) UP to the dashboard stash. The browser then pulls
// it from /api/file-manager/download/<id>. `?error=1` (with x-file-error) signals
// a prep failure so the browser's poll resolves instead of hanging.
//
// Auth: x-asst-key → machine; the download id must have been created for THAT
// machine (createDownload in the tRPC prepareDownload). Body streams straight to
// disk — never buffered whole.

export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { mkdir, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { basename, join } from 'node:path';
import { platform } from 'node:os';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolveMachineByKey } from '@/server/auth';
import { getDownload, markDownloadReady, markDownloadError, deleteDownload } from '@/server/gateway-bridge';

// Generous ceiling: a zipped folder can exceed the 100 MB single-file UPLOAD cap.
const MAX_BYTES = 512 * 1024 * 1024;
const STASH_TTL_MS = 10 * 60_000;

function fileManagerDir(): string {
  const root = process.env.HERMIT_UPLOAD_DIR || (platform() === 'linux' ? '/var/hermit-ui/uploads' : '/tmp/hermit-ui/uploads');
  return join(root, 'file-manager');
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const machine = await resolveMachineByKey(req.headers.get('x-asst-key') || '');
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await params;
  const entry = getDownload(id);
  if (!entry || entry.machineId !== machine.id) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Failure signal from the gateway's prepare step.
  if (new URL(req.url).searchParams.get('error') === '1') {
    let msg = '准备失败';
    try {
      msg = decodeURIComponent(req.headers.get('x-file-error') || msg);
    } catch {
      /* keep default */
    }
    markDownloadError(id, msg);
    return NextResponse.json({ ok: true });
  }

  let filename = req.headers.get('x-file-name') || 'download';
  try {
    filename = decodeURIComponent(filename);
  } catch {
    /* use as-is */
  }
  filename = basename(filename).slice(0, 200) || 'download';

  if (!req.body) return NextResponse.json({ error: 'no body' }, { status: 400 });

  const dir = fileManagerDir();
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `${id}.part`);

  let received = 0;
  const cap = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (received > MAX_BYTES) return cb(new Error('文件超过 512MB 暂存上限'));
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(req.body as Parameters<typeof Readable.fromWeb>[0]), cap, createWriteStream(tmp));
    await rename(tmp, join(dir, `${id}.bin`));
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    markDownloadError(id, '接收失败：' + (e instanceof Error ? e.message : String(e)));
    return NextResponse.json({ error: 'ingest failed' }, { status: 400 });
  }

  markDownloadReady(id, filename, received);
  // Reap the stash after a window long enough for the browser to pull it.
  const binPath = join(dir, `${id}.bin`);
  setTimeout(() => {
    void rm(binPath, { force: true }).catch(() => {});
    deleteDownload(id);
  }, STASH_TTL_MS);

  return NextResponse.json({ ok: true, size: received });
}
