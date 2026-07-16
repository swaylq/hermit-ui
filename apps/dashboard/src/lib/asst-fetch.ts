// Single client-side authenticated fetch: injects the active machine key as the
// `x-asst-key` header (the same auth every dashboard API route + sync surface
// reads server-side). Replaces the hand-written `headers: { 'x-asst-key':
// getActiveKey() }` that was copy-pasted across call sites. The key is read fresh
// per call from the keyring's active entry (and never logged). Caller-supplied
// init/headers pass through unchanged; x-asst-key is set last so it always wins.
//
// Scope note: this covers plain `fetch` call sites. The XHR uploads
// (file-station / agent-files) set the header via `xhr.setRequestHeader` among
// several others, the tRPC client injects it in its own `headers()` link, and
// the terminal WS carries it as a subprotocol — those keep their own paths.
import { getActiveKey } from '@/lib/keyring';

export function authedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('x-asst-key', getActiveKey());
  return fetch(input, { ...init, headers });
}
