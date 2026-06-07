import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';

// Optimistically reflect a skill add/remove in the cached agent so the detail
// view (it renders `agent.skillNames`) updates the INSTANT the mutation returns —
// no polling. The gateway applies the real file change asynchronously (~3-6s) and
// its later re-sync reconciles the content; the binding/status query is written
// synchronously by the mutation, so a single invalidate refreshes its chips.
//
// These are `setData` updaters: `utils.agents.byName.setData({ name }, addAgentSkill(slug))`.
// byName returns `{ agent } | null`; `skills` is a Prisma Json field (cast it).
// Other surfaces that mutate through the async gateway queue can borrow the shape.

type ByName = NonNullable<inferRouterOutputs<AppRouter>['agents']['byName']>;
type ByNameCache = ByName | null | undefined;
type SkillDoc = { name: string; content: string };

export const removeAgentSkill = (skillName: string) => (old: ByNameCache): ByNameCache => {
  if (!old) return old;
  const skills = (old.agent.skills as SkillDoc[]).filter((s) => s.name !== skillName);
  return {
    ...old,
    agent: { ...old.agent, skillNames: old.agent.skillNames.filter((n) => n !== skillName), skills: skills as typeof old.agent.skills },
  };
};

export const addAgentSkill = (skillName: string) => (old: ByNameCache): ByNameCache => {
  if (!old) return old;
  if (old.agent.skillNames.includes(skillName)) return old; // already present (e.g. a pull-update)
  const skills = [...(old.agent.skills as SkillDoc[]), { name: skillName, content: '' }]; // content fills on next sync
  return {
    ...old,
    agent: { ...old.agent, skillNames: [...old.agent.skillNames, skillName].sort(), skills: skills as typeof old.agent.skills },
  };
};
