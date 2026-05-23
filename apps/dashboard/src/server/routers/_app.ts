import { router } from '../trpc';
import { machinesRouter } from './machines';
import { agentsRouter } from './agents';
import { eventsRouter } from './events';
import { tasksRouter } from './tasks';
import { usageRouter } from './usage';
import { chatRouter } from './chat';

export const appRouter = router({
  machines: machinesRouter,
  agents: agentsRouter,
  events: eventsRouter,
  tasks: tasksRouter,
  usage: usageRouter,
  chat: chatRouter,
});

export type AppRouter = typeof appRouter;
