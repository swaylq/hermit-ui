// Shared chat-queue constants. Plain module (no server-only imports) so BOTH the
// tRPC router (server/routers/chat.ts — enforcement) and the chat page
// (app/chat/page.tsx — pre-disable + label) import the same number.
//
// QUEUE_LIMIT is the max number of WAITING messages per session (messages the
// gateway hasn't picked up yet, i.e. deliveredAt=null). The in-flight turn's
// message is already delivered and does NOT count → "1 running + up to 5 queued".
export const QUEUE_LIMIT = 5;

/**
 * What counts as a QUEUE message: one the USER composed in the dashboard
 * composer (`chat.send`), not yet picked up by the gateway.
 *
 * The decisive field is `externalId === null`. `send` never sets one, whereas
 * every row the gateway syncs FROM the claude transcript carries the JSONL uuid
 * — and those rows are ALSO `role:'user'` with `deliveredAt:null`, because a
 * tool_result (or an image the agent Read mid-task) is role 'user' in
 * Anthropic's format. Drop the guard and the count scoops up the agent's own
 * tool output: a working session read "排队 511" on a Lock Screen the first time
 * this was written out by hand instead of imported.
 *
 * Lives here rather than in routers/chat.ts so a consumer outside the router —
 * the Live Activity, which runs off the snapshot write — can share it without
 * importing the whole tRPC graph.
 */
export const USER_QUEUE_FILTER = { role: 'user', deliveredAt: null, externalId: null } as const;

/**
 * The charset a `chat.send` idempotency key may use, and the router's own zod
 * check (`send`'s `clientId`). Deliberately narrow rather than a bare string: it
 * covers every id a client would actually generate (UUID, cuid, ULID,
 * `<install>:<seq>`) while making a NUL byte — which Postgres refuses to store
 * in a text column — a zod error at the edge instead of a failed INSERT halfway
 * through the mutation.
 *
 * Here rather than inline in the router because a client outside this codebase
 * has to satisfy it: the iOS composer mints these, and
 * `apps/ios/tools/composer-fixture.sh` holds its port against this exact
 * pattern. A regex the only consumer can read is a regex the other consumer
 * guesses at.
 */
export const CLIENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
