// GET /api/file-station/download/<id> — the gateway streams the stashed file
// down to the machine. Auth: x-asst-key → machine; the FileTransfer must belong
// to it. The temp file is deleted later, when the gateway acks the transfer done.

export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { platform } from 'node:os';
import { Readable } from 'node:stream';
import { prisma } from '@/server/db';
import { resolveMachineByKey } from '@/server/auth';

function fileStationDir(): string {
  const root = process.env.HERMIT_UPLOAD_DIR || (platform() === 'linux' ? '/var/hermit-ui/uploads' : '/tmp/hermit-ui/uploads');
  return join(root, 'file-station');
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const machine = await resolveMachineByKey(req.headers.get('x-asst-key') || '');
  if (!machine) return new NextResponse('unauthorized', { status: 401 });

  const { id } = await params;
  const ft = await prisma.fileTransfer.findFirst({ where: { id, machineId: machine.id }, select: { id: true } });
  if (!ft) return new NextResponse('not found', { status: 404 });

  const path = join(fileStationDir(), `${id}.bin`);
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return new NextResponse('file gone', { status: 410 });
  }

  const webStream = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream;
  return new NextResponse(webStream, {
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(size) },
  });
}
