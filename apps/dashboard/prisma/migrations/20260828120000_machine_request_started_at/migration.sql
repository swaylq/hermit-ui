-- When the gateway claimed the request (its first `running` ack).
-- Null on every existing row and on any request no gateway has taken yet.
ALTER TABLE "MachineRequest" ADD COLUMN "startedAt" TIMESTAMP(3);
