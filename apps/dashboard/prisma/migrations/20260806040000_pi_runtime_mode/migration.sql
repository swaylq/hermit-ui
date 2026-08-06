-- pi modes: which spawn recipe (system prompt, tool allowlist, skills,
-- extensions) a pi session runs under.
--
-- NULL on both levels means "inherit, then the fleet default ('coding')", which
-- is what every existing row gets — so this migration is behaviourally a no-op.
-- Resolution happens in resolveRuntime, alongside runtime/provider/model, and
-- yields NULL for anything that is not pi-rpc.
--
-- The mode NAME is stored; the recipe itself lives on the gateway's disk under
-- apps/gateway/pi-modes/<name>/. An unknown name is not an error — the gateway
-- falls back to the default mode and logs it — so no FK or CHECK here.
ALTER TABLE "ChatSession" ADD COLUMN "runtimeMode" TEXT;
ALTER TABLE "Agent" ADD COLUMN "runtimeMode" TEXT;
