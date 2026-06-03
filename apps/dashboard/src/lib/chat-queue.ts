// Shared chat-queue constants. Plain module (no server-only imports) so BOTH the
// tRPC router (server/routers/chat.ts — enforcement) and the chat page
// (app/chat/page.tsx — pre-disable + label) import the same number.
//
// QUEUE_LIMIT is the max number of WAITING messages per session (messages the
// gateway hasn't picked up yet, i.e. deliveredAt=null). The in-flight turn's
// message is already delivered and does NOT count → "1 running + up to 5 queued".
export const QUEUE_LIMIT = 5;
