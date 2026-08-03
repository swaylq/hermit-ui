-- Which backend runs each agent.
--
-- Every existing row defaults to 'claude-tmux', which is exactly what they are
-- doing today, so this migration is a no-op behaviourally. 'pi-rpc' is opt-in
-- per agent and nothing selects it until an operator does.
--
-- provider/model are pi-only: a claude agent's model comes from that machine's
-- ~/.claude/settings.json, not from here.
ALTER TABLE "Agent" ADD COLUMN "runtime" TEXT NOT NULL DEFAULT 'claude-tmux';
ALTER TABLE "Agent" ADD COLUMN "runtimeProvider" TEXT;
ALTER TABLE "Agent" ADD COLUMN "runtimeModel" TEXT;
