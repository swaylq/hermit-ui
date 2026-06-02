import { router } from '../trpc';
import { machinesRouter } from './machines';
import { agentsRouter } from './agents';
import { skillsRouter } from './skills';
import { cronRouter } from './cron';
import { usageRouter } from './usage';
import { chatRouter } from './chat';
import { interactionRouter } from './interaction';

export const appRouter = router({
  machines: machinesRouter,
  agents: agentsRouter,
  skills: skillsRouter,
  cron: cronRouter,
  usage: usageRouter,
  chat: chatRouter,
  interaction: interactionRouter,
});

export type AppRouter = typeof appRouter;
