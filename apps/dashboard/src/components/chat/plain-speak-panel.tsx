'use client';

// The 「说人话」 panel: one assistant reply, said again in language you can act
// on, in a box under the reply itself.
//
// UNDER, not instead of. Translation swaps the bubble's text because a
// translation IS the message — same claims, different language. A rewrite is
// not: it drops detail, rounds numbers off, and is written by a different model
// than the one that did the work. Covering the original with it would leave the
// reader unable to check anything, and would move every row below by the length
// difference at the moment they are reading. Growing downwards from a tap costs
// neither.
//
// The label says who wrote it for the same reason. The words in this box are
// not the agent's, and a reader who quotes them back at the agent should know
// that.

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { TypedText, StreamingDots } from '@/components/chat/message-bits';
import { plainKey } from '@/lib/plain-speak';
import {
  requestPlain,
  getPlain,
  plainFailed,
  plainUnavailable,
  subscribePlain,
  plainVersion,
} from '@/lib/plain-speak-store';

function zeroVersion(): number {
  return 0;
}

export function PlainSpeakPanel({ text, sessionId }: { text: string; sessionId: string }) {
  // One subscription per open panel to a global counter — the store is read
  // imperatively below, so this is what tells React an answer landed.
  const version = useSyncExternalStore(subscribePlain, plainVersion, zeroVersion);
  const key = useMemo(() => plainKey(text), [text]);

  useEffect(() => {
    requestPlain(sessionId, text);
  }, [sessionId, text]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const value = useMemo(() => getPlain(key), [key, version]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const failed = useMemo(() => plainFailed(key), [key, version]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const unavailable = useMemo(() => plainUnavailable(), [version]);

  return (
    <div className="mt-1.5 rounded-md border border-border bg-muted/40 px-3 py-2 space-y-1">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        说人话 · 另一个模型的转述
      </div>
      {value ? (
        // Typed rather than dropped in whole: the reveal is the feedback that
        // this arrived, and it is height growing under the reader's own eyes,
        // below everything they have already read.
        <div className="text-sm text-foreground/90">
          <TypedText text={value} typing streamKey={`plain:${key}`} />
        </div>
      ) : unavailable ? (
        <div className="text-xs text-muted-foreground">
          这台 dashboard 没配 <code className="font-mono">OPENROUTER_API_KEY</code>，转述用不了。
        </div>
      ) : failed ? (
        <div className="text-xs text-muted-foreground">没转述成功。收起再点一次可以重试。</div>
      ) : (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <StreamingDots variant="chip" dot="bg-muted-foreground" />
          正在读懂这段话…
        </div>
      )}
    </div>
  );
}
