// GET /api/file-manager/download/<id> — the browser pulls a prepared download
// from the dashboard stash (the gateway streamed it up via /ingest). Auth:
// x-asst-key → machine; the download id must belong to it and be `ready`. The
// browser fetches this with the key header, then saves the blob — a plain
// <a download> can't carry the header.

export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { platform } from 'node:os';
import { Readable } from 'node:stream';
import { resolveKey } from '@/server/auth';
import { getDownload } from '@/server/gateway-bridge';

function fileManagerDir(): string {
  const root = process.env.HERMIT_UPLOAD_DIR || (platform() === 'linux' ? '/var/hermit-ui/uploads' : '/tmp/hermit-ui/uploads');
  return join(root, 'file-manager');
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  // resolveKey accepts a machine key OR an agent share token (a scoped user
  // downloading a file from their own agent's directory). The download id was
  // created by their prepareDownload, so the machineId guard below suffices.
  const machine = (await resolveKey(req.headers.get('x-asst-key') || ''))?.machine;
  if (!machine) return new NextResponse('unauthorized', { status: 401 });

  const { id } = await params;
  const entry = getDownload(id);
  if (!entry || entry.machineId !== machine.id) return new NextResponse('not found', { status: 404 });
  if (entry.status === 'error') return new NextResponse(entry.error || 'prepare failed', { status: 410 });
  if (entry.status !== 'ready') return new NextResponse('not ready', { status: 409 });

  const path = join(fileManagerDir(), `${id}.bin`);
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return new NextResponse('file gone', { status: 410 });
  }

  const webStream = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream;
  const dispositionName = encodeURIComponent(entry.filename || 'download');
  return new NextResponse(webStream, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(size),
      'content-disposition': `attachment; filename*=UTF-8''${dispositionName}`,
    },
  });
}
