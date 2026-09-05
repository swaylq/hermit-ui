import { router } from '../trpc';
import { machinesRouter } from './machines';
import { agentsRouter } from './agents';
import { skillsRouter } from './skills';
import { cronRouter } from './cron';
import { usageRouter } from './usage';
import { chatRouter } from './chat';
import { interactionRouter } from './interaction';
import { marketRouter } from './market';
import { fileStationRouter } from './fileStation';
import { fileManagerRouter } from './fileManager';
import { globalMemoryRouter } from './globalMemory';
import { knowledgeRouter } from './knowledge';
import { secretsRouter } from './secrets';
import { shareRouter } from './share';
import { hostsRouter } from './hosts';
import { alertsRouter } from './alerts';
import { watchdogsRouter } from './watchdogs';
import { pushRouter } from './push';
import { sessionGroupsRouter } from './sessionGroups';

export const appRouter = router({
  machines: machinesRouter,
  agents: agentsRouter,
  skills: skillsRouter,
  cron: cronRouter,
  usage: usageRouter,
  chat: chatRouter,
  interaction: interactionRouter,
  market: marketRouter,
  fileStation: fileStationRouter,
  fileManager: fileManagerRouter,
  globalMemory: globalMemoryRouter,
  knowledge: knowledgeRouter,
  secrets: secretsRouter,
  share: shareRouter,
  hosts: hostsRouter,
  alerts: alertsRouter,
  watchdogs: watchdogsRouter,
  push: pushRouter,
  sessionGroups: sessionGroupsRouter,
});

export type AppRouter = typeof appRouter;
