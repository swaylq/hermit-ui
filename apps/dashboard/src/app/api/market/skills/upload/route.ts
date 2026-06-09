// POST /api/market/skills/upload — publish a skill package (.zip) to the market.
//
// multipart/form-data:
//   file         <Blob>    a .zip whose tree is rooted at a SKILL.md, ≤5 MB
//   slug         <string?> override the derived slug (lowercase-slug rules)
//   displayName  <string?> override the display name
//   changelog    <string?> note for this version
//
// Auth: x-asst-key header (same machine key the rest of the dashboard uses).
// The Market* tables are fleet-global; ctx.machine is recorded as the publisher.
// No schema change — it lands the exact { content, refs } shape publishSkillFromLocal does.

import { NextRequest, NextResponse } from 'next/server';
import { resolveMachineByKey } from '@/server/auth';
import { parseSkillZip } from '@/server/market-zip';
import { upsertMarketSkillVersion } from '@/server/market-publish';

export const runtime = 'nodejs';

const MAX_ZIP_BYTES = 5 * 1024 * 1024;
const SLUG_RE = /^[a-z][a-z0-9-]{0,60}$/;

export async function POST(req: NextRequest) {
  const machine = await resolveMachineByKey(req.headers.get('x-asst-key') ?? '');
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return NextResponse.json({ error: 'bad form data', detail: String(e) }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof Blob)) return NextResponse.json({ error: 'file (.zip) required' }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: 'empty file' }, { status: 400 });
  if (file.size > MAX_ZIP_BYTES) {
    return NextResponse.json({ error: `zip too large (max ${MAX_ZIP_BYTES / 1024 / 1024} MB)` }, { status: 413 });
  }

  let parsed;
  try {
    parsed = await parseSkillZip(await file.arrayBuffer());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }

  const slugOverride = (form.get('slug') as string | null)?.trim().toLowerCase();
  const slug = slugOverride || parsed.slug;
  if (!slug || !SLUG_RE.test(slug)) {
    return NextResponse.json(
      { error: 'invalid or missing slug — need a name in SKILL.md frontmatter / a top folder, or pass a slug (lowercase letter, then letters/digits/hyphens)' },
      { status: 400 },
    );
  }
  const displayName = ((form.get('displayName') as string | null)?.trim()) || parsed.displayName || slug;
  const changelogInput = (form.get('changelog') as string | null)?.trim();
  const changelog = changelogInput || `uploaded · ${parsed.fileCount} file${parsed.fileCount === 1 ? '' : 's'}`;

  let result;
  try {
    result = await upsertMarketSkillVersion({
      slug,
      displayName,
      description: parsed.description,
      content: parsed.content,
      refs: parsed.refs,
      changelog,
      origin: 'uploaded',
      machineId: machine.id,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    slug: result.slug,
    displayName,
    latestVersion: result.latestVersion,
    created: result.created, // false ⇒ identical content, no new version appended
    fileCount: parsed.fileCount,
    skipped: parsed.skipped,
  });
}
