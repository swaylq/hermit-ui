// Create a market skill or append a new version — the shared core behind
// publishSkillFromLocal / commitImport / the .zip upload route. Dedupes on
// content hash (re-publishing identical content is a no-op), bumps the integer
// version string otherwise. Returns enough for the caller to bind provenance.

import { prisma } from './db';
import { hashContent, type SkillRef } from './skill-hash';

export type UpsertSkillArgs = {
  slug: string;
  displayName: string;
  description: string | null;
  content: string;
  refs: SkillRef[];
  changelog?: string | null;
  origin?: string; // defaults to 'uploaded' on create; only overwrites on update if provided
  originUrl?: string | null;
  machineId: string;
  publishedByAgent?: string | null;
};

export async function upsertMarketSkillVersion(
  args: UpsertSkillArgs,
): Promise<{ id: string; slug: string; latestVersion: string; created: boolean }> {
  const { slug, displayName, description, content, refs, machineId } = args;
  const changelog = args.changelog ?? null;
  const hash = hashContent(content, refs);
  const fileCount = 1 + refs.length;

  const existing = await prisma.marketSkill.findUnique({
    where: { slug },
    include: { versions: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });

  if (existing) {
    // Identical content → no new version (created: false). Same dedupe the
    // publish/import procedures do.
    if (existing.versions[0]?.contentHash === hash) {
      return { id: existing.id, slug: existing.slug, latestVersion: existing.latestVersion, created: false };
    }
    const nextVer = String((parseInt(existing.latestVersion, 10) || 0) + 1);
    await prisma.marketSkillVersion.create({
      data: { marketSkillId: existing.id, version: nextVer, content, refs, fileCount, contentHash: hash, changelog, createdByMachineId: machineId },
    });
    const updated = await prisma.marketSkill.update({
      where: { id: existing.id },
      data: {
        latestVersion: nextVer,
        description,
        displayName,
        ...(args.origin ? { origin: args.origin } : {}),
        ...(args.originUrl !== undefined ? { originUrl: args.originUrl } : {}),
      },
    });
    return { id: updated.id, slug: updated.slug, latestVersion: updated.latestVersion, created: true };
  }

  const created = await prisma.marketSkill.create({
    data: {
      slug,
      displayName,
      description,
      origin: args.origin ?? 'uploaded',
      originUrl: args.originUrl ?? null,
      latestVersion: '1',
      publishedByMachineId: machineId,
      publishedByAgent: args.publishedByAgent ?? null,
      versions: { create: { version: '1', content, refs, fileCount, contentHash: hash, changelog, createdByMachineId: machineId } },
    },
  });
  return { id: created.id, slug: created.slug, latestVersion: created.latestVersion, created: true };
}
