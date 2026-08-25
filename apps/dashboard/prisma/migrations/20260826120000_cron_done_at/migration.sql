-- Cron.doneAt — a cron that reached its own finish line.
--
-- The session-scoped "loop" is gone; every repeating task is a Cron now, including
-- the ones that iterate toward a goal and must end themselves. A run signals that by
-- printing a lone CRON_DONE line; the gateway strips it and the finish handler sets
-- enabled = false AND stamps doneAt. Without this column "finished its goal" and
-- "a human paused it" are the same row, and the UI cannot tell 已完成 from 已暂停.
ALTER TABLE "Cron" ADD COLUMN "doneAt" TIMESTAMP(3);
