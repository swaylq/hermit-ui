-- Agent share links gain a PUBLIC mode. When isPublic is true the link's token is
-- deterministic (derived from the machine name + agent name, `pub_…`), not a
-- bcrypt-hashed secret, so the link opens with no password. Default false keeps
-- every existing link private — the new code is the only reader of the flag.
ALTER TABLE "AgentShareLink" ADD COLUMN "isPublic" BOOLEAN NOT NULL DEFAULT false;
