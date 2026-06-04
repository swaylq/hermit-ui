// market-template.ts — condense an agent into a reusable template, stripping
// private traits (USER.md, accounts/secrets in TOOLS.md, auto-memory, evolution
// narrative) and genericizing the name. See docs/marketplace-design.md (Phase D).
//
// What a template KEEPS: IDENTITY.md (persona, name → {{AGENT_NAME}}), AGENTS.md
// (workspace rules + mission), and the agent's skills (.claude/skills/<n>/SKILL.md).
// Everything else comes from the up-to-date built-in scaffold at create time.

export type TemplateFile = { path: string; content: string };

export type AgentForTemplate = {
  name: string;
  identityText: string | null;
  agentsText: string | null;
  skills: Array<{ name: string; content: string }>;
  skillNames: string[];
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Replace the agent's own name with the {{AGENT_NAME}} placeholder the base
// template already uses, so a template doesn't bake in the source agent's name.
function genericize(text: string | null, agentName: string): string {
  if (!text) return '';
  if (agentName.length < 2) return text; // too short to safely word-replace
  return text.replace(new RegExp(`\\b${escapeRegExp(agentName)}\\b`, 'gi'), '{{AGENT_NAME}}');
}

function extractPersona(identity: string | null): string | null {
  if (!identity) return null;
  // A "**Persona:** …" / "Vibe: …" line, else the first non-heading prose line.
  const m = identity.match(/^\s*[-*]?\s*\*?\*?(?:persona|vibe|role)\*?\*?\s*[:：]\s*(.+)$/im);
  if (m) return m[1].replace(/[*`]/g, '').trim().slice(0, 200);
  return null;
}

export function buildTemplate(agent: AgentForTemplate): {
  files: TemplateFile[];
  basePersona: string | null;
  kept: string[];
  stripped: string[];
} {
  const files: TemplateFile[] = [];
  if (agent.identityText) files.push({ path: 'IDENTITY.md', content: genericize(agent.identityText, agent.name) });
  if (agent.agentsText) files.push({ path: 'AGENTS.md', content: genericize(agent.agentsText, agent.name) });

  const byName = new Map(agent.skills.map((s) => [s.name, s.content]));
  for (const name of agent.skillNames) {
    const c = byName.get(name);
    if (c != null) files.push({ path: `.claude/skills/${name}/SKILL.md`, content: genericize(c, agent.name) });
  }

  const kept = files.map((f) => f.path);
  const stripped = ['USER.md', 'TOOLS.md（账号 / 密钥）', 'memory/（Claude Code auto-memory）', 'evolution/（accounts · heartbeat · reflections · lessons）'];
  return { files, basePersona: extractPersona(agent.identityText), kept, stripped };
}
