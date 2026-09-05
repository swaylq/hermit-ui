/**
 * The one string the chat header leads with.
 *
 * Four candidates, JavaScript's falsiness deciding between them: an EMPTY title
 * falls through to the preview rather than printing a blank header, which is
 * exactly the state a brand-new session is in. The tail is the session id's
 * first eight characters — the header, unlike the sidebar row, is the whole
 * screen's name and cannot be allowed to render as nothing.
 *
 * Extracted from `app/chat/page.tsx`, where it was an inline `||` chain, so the
 * iOS port can be held against the function the page actually runs rather than
 * against someone's reading of it (apps/ios/tools/header-fixture.sh).
 */
export function chatHeaderTitle(
  session: { title?: string | null; preview?: string | null; agentName?: string | null } | null | undefined,
  sessionId: string,
): string {
  return session?.title || session?.preview || session?.agentName || sessionId.slice(0, 8);
}
