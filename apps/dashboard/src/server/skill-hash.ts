import crypto from 'node:crypto';

export type SkillRef = { path: string; content: string };

// Stable content hash for a skill version (SKILL.md + its ref files). Used both
// to dedupe versions on publish (market router) and to match an agent's local
// skill to the market version it actually has (sync/agents auto-bind). Keep the
// two in sync — they're the same function, hence this shared module.
export function hashContent(content: string | null, refs: SkillRef[]): string {
  return crypto.createHash('sha256').update(JSON.stringify({ content, refs })).digest('hex').slice(0, 16);
}
