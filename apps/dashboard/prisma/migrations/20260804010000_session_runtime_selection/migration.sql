-- Per-session backend selection.
--
-- NULL means "inherit the agent's default", which is what every existing row
-- gets, so this migration is behaviourally a no-op. Resolution happens in
-- chat.pollPending: session.runtime ?? agent.runtime ?? 'claude-tmux'.
ALTER TABLE "ChatSession" ADD COLUMN "runtime" TEXT;
ALTER TABLE "ChatSession" ADD COLUMN "runtimeProvider" TEXT;
ALTER TABLE "ChatSession" ADD COLUMN "runtimeModel" TEXT;
