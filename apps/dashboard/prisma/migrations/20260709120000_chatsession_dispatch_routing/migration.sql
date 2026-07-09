-- Brain dispatch routing (docs/brain-design.md Phase 2). Two additive, nullable
-- columns on ChatSession so the gateway dispatch-watcher can push a dispatch's
-- outcome back to the Brain that opened it:
--   dispatchedBySessionId — the Brain chat session that opened this dispatch
--                           (set by the `dispatch` MCP tool); the watcher pokes
--                           THIS session when the dispatch finishes or blocks.
--   dispatchNotify        — dedup marker: the last state signature the watcher
--                           already poked about, so it fires once per transition.
-- Both nullable + no default → can't fail, needs no backfill; existing rows get
-- NULL (legacy dispatches simply aren't watched, matching prior behavior).
ALTER TABLE "ChatSession" ADD COLUMN "dispatchedBySessionId" TEXT;
ALTER TABLE "ChatSession" ADD COLUMN "dispatchNotify" TEXT;
