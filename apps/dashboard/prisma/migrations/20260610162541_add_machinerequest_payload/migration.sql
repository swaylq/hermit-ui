-- Short-lived secret input for login-claude-account requests (wiped by the
-- gateway the instant it claims the row). Nullable TEXT.
ALTER TABLE "MachineRequest" ADD COLUMN "payload" TEXT;
