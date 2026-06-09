// GET /api/market/skills/<slug>/download[?version=N] — download a market skill
// as a .zip (SKILL.md + ref files, rooted at <slug>/). Defaults to the latest
// version. Auth: x-asst-key header — the client fetches with the header and
// saves the blob (a plain <a download> can't carry the key).

import { NextRequest, NextResponse } from 'next/server';
import { resolveMachineByKey } from '@/server/auth';
import { prisma } from '@/server/db';
import { buildSkillZip, type SkillRef } from '@/server/market-zip';

export const runtime = 'nodejs';

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const machine = await resolveMachineByKey(req.headers.get('x-asst-key') ?? '');
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { slug } = await params;
  const market = await prisma.marketSkill.findUnique({
    where: { slug },
    include: { versions: { orderBy: { createdAt: 'desc' } } },
  });
  if (!market) return NextResponse.json({ error: 'skill not found' }, { status: 404 });

  const want = req.nextUrl.searchParams.get('version');
  const ver = want ? market.versions.find((v) => v.version === want) : market.versions[0];
  if (!ver || ver.content == null) {
    return NextResponse.json({ error: 'no downloadable version (bundle-only skill?)' }, { status: 404 });
  }

  const refs = (ver.refs as unknown as SkillRef[] | null) ?? [];
  const buf = await buildSkillZip({ slug: market.slug, content: ver.content, refs });
  const filename = `${market.slug}-v${ver.version}.zip`;

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(buf.length),
      'Cache-Control': 'no-store',
    },
  });
}
