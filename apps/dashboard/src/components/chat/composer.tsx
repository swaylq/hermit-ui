'use client';

// The chat composer and its queue strip. Extracted verbatim from chat/page.tsx
// (P2-3); behaviour identical. ComposeBar (textarea + send + attachments) and
// QueueBar (the waiting-dispatch strip) are the two exports, both consumed by
// SessionPane; AttachmentChip / readyLabel / getExt / readImageDims and the
// SAFE_FILE_* / MAX_* file constants are module-private, used only within this
// cluster.

import { useState, useRef, useCallback, useEffect, useMemo, forwardRef, useImperativeHandle, type ChangeEvent, type ClipboardEvent, type DragEvent } from 'react';
import { cn } from '@/lib/utils';
import { authedFetch } from '@/lib/asst-fetch';
import { isTouchPrimary } from '@/lib/save-file';
import { QUEUE_LIMIT } from '@/lib/chat-queue';
import { foldTail, newClaim, replaceTail, type DictationClaim } from '@/lib/dictation-text';
import dynamic from 'next/dynamic';
import { Plus, ArrowUp, FileText, Loader2, Mic, X } from 'lucide-react';
import { msgText, type Attachment } from '@/components/chat/lib';
import { Collapse } from '@/components/chat/collapse';
import { originalFor } from '@/lib/translate-outbound';
import { canOpenMicSilently, refreshMicPermission, requestMicAccess } from '@/lib/voice-capture';
import { HoldToTalkOverlay, type HoldPhase, type HoldZone } from '@/components/chat/hold-to-talk';
import type { DictationSource } from '@/components/chat/dictation-dock';

// Lazy-load the zoomable image lightbox (its own ~20KB portal-overlay chunk) so
// the chat composer's first paint doesn't carry it — only an attachment preview
// opens it. ssr:false, no loading fallback (renders null while closed anyway). (P3-5)
const ImageLightbox = dynamic(() => import('@/components/ui/image-lightbox').then((m) => m.ImageLightbox), { ssr: false });

/** msgText, but showing a translated-on-send message as it was typed. */
function queuePreview(content: unknown): string {
  const t = msgText(content);
  return (t && originalFor(t)) || t;
}

// The waiting-dispatch queue strip, shown between the ScheduleBar and the composer
// whenever messages are queued behind the in-flight turn. Each item can be
// pulled (✕ → dequeue) before the gateway sends it; "清空队列" empties the lot.
// Reuses the module-scope msgText to render a one-line preview.
export function QueueBar({
  items,
  onCancel,
  onClear,
  clearing,
}: {
  items: Array<{ id: string; content: unknown }>;
  onCancel: (id: string) => void;
  onClear: () => void;
  clearing: boolean;
}) {
  return (
    <Collapse open={items.length > 0} className="mx-auto w-full max-w-3xl px-3">
      <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
        <div className="mb-1 flex items-center justify-between text-muted-foreground">
          <span>{items.length} 条排队中 · 等当前任务完成后依次执行</span>
          <button
            type="button"
            onClick={onClear}
            disabled={clearing}
            className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground transition-colors disabled:opacity-40 cursor-pointer"
          >
            清空队列
          </button>
        </div>
        <ul className="flex flex-col gap-1">
          {items.map((it, i) => (
            <li key={it.id} className="flex items-center gap-2 min-w-0">
              <span className="shrink-0 tabular-nums text-muted-foreground/60">{i + 1}.</span>
              {/* What the reader typed, not the English it was translated into
                  on the way out — otherwise the bubble above shows Chinese and
                  this strip shows English for the same message. */}
              <span className="min-w-0 flex-1 truncate text-foreground/80">{queuePreview(it.content) || '（附件）'}</span>
              <button
                type="button"
                onClick={() => onCancel(it.id)}
                aria-label="cancel queued message"
                title="移出队列"
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Collapse>
  );
}

// ── Composer draft persistence ──────────────────────────────────────────────
// Keep unsent text per session in localStorage so switching away and back
// (SessionPane remounts on session change) doesn't lose what you typed. Cleared
// on send / Escape (setDraft('') → the save effect removes the key). Draft state
// lives HERE (not in SessionPane) so a keystroke re-renders only the composer,
// not the whole chat pane (timeline / voice FAB / loop bar). SessionPane's
// occasional draft writes (empty-state chip, voice transcript, send clear /
// restore) go through the imperative ComposerHandle below.
// Stop the running turn. A pill, not a circle, and rose, not foreground —
// whatever else changes, it must never be confusable with the send button an
// inch to its right. See the note on `working` below for why that matters.
function StopPill({ onStop, stopping }: { onStop: () => void; stopping: boolean }) {
  // A turn can start while a finger is already moving toward this corner, so the
  // button ignores clicks that arrive before it has been on screen long enough
  // to have been aimed at.
  const ARM_MS = 400;
  const shownAt = useRef(0);
  useEffect(() => { shownAt.current = Date.now(); }, []);
  return (
    <button
      type="button"
      onClick={() => {
        if (Date.now() - shownAt.current < ARM_MS) return;
        onStop();
      }}
      disabled={stopping}
      aria-label={stopping ? 'stopping' : 'stop this turn'}
      title={stopping ? 'stopping…' : 'stop this turn (Esc)'}
      className={cn(
        // h-9, matching the clear/send buttons beside it. The row is `items-end`,
        // so a shorter pill bottom-aligns and reads as sitting low rather than
        // centred — which is exactly what it looked like at h-8.
        'mr-1 h-9 shrink-0 inline-flex items-center gap-1.5 rounded-full border border-rose-500/40',
        'px-2.5 text-xs font-medium text-rose-600 dark:text-rose-400',
        'transition-colors cursor-pointer hover:bg-rose-500/10',
        'disabled:cursor-wait disabled:opacity-60',
      )}
    >
      <span className="h-2.5 w-2.5 rounded-[2px] bg-current" aria-hidden="true" />
      {stopping ? 'stopping…' : 'Stop'}
    </button>
  );
}

// ── press-and-hold-to-talk thresholds ───────────────────────────────────────
/** Hold the empty box this long and the press has become "talking". */
const HOLD_MS = 260;
/** Travel this far before that and it was a scroll passing through, not a hold. */
const BAIL_PX = 10;
/** Slide this far sideways, from where the finger went down, to pick 取消 / 编辑. */
const SLIDE_PX = 64;
/** Below this the finger hasn't gone anywhere, so the pill hit-test stays off. */
const PILL_MIN_PX = 24;

const draftKey = (sid: string) => `hermit:draft:${sid}`;
function loadDraft(sid: string): string {
  try { return localStorage.getItem(draftKey(sid)) ?? ''; } catch { return ''; }
}
function saveDraft(sid: string, v: string) {
  try { if (v) localStorage.setItem(draftKey(sid), v); else localStorage.removeItem(draftKey(sid)); } catch {}
}

// Imperative surface SessionPane uses for the rare, out-of-band draft writes it
// still owns (the draft VALUE no longer lives there, so these can't be props).
export interface ComposerHandle {
  /** Replace the draft, focus, caret-to-end, resize (empty-state chip / slash templates). */
  setText: (text: string) => void;
  /** Append to the draft (voice transcript), focus, caret-to-end, resize. */
  appendText: (text: string) => void;
  /** Clear the draft (optimistic clear on send). */
  clear: () => void;
  /** Put a value back (restore the draft after a failed send). */
  restore: (text: string) => void;
  /** Start a dictation run — the draft as it stands becomes the frozen base. */
  beginDictation: () => void;
  /** Replace everything the run has dictated so far with `tail`. */
  setDictationTail: (tail: string) => void;
  /**
   * Land the end-of-run whole-passage correction over the run's tail. Unlike
   * setDictationTail this gives up rather than rebasing when the draft has moved
   * — see replaceTail in lib/dictation-text.ts.
   */
  refineDictationTail: (tail: string) => void;
  /** What was in the draft before the run started — reference for the refine. */
  dictationBase: () => string;
  /**
   * End the run; the tail becomes ordinary draft text. `discard` throws that
   * tail away instead, leaving the draft as it was before the run started.
   *
   * Discarding has to happen HERE rather than through a setDictationTail('')
   * followed by an end: that call queues an updater which reads the run's claim
   * when React gets round to it, by which point ending the run has already
   * cleared the claim — so the updater bails and the words stay in the box.
   */
  endDictation: (discard?: boolean) => void;
}

export const ComposeBar = forwardRef<ComposerHandle, {
  sessionId: string;
  disabled: boolean;
  awaitingInput?: boolean;
  sending: boolean;
  inFlight: boolean;
  /** What the Brain is composing right now, while it drives this conversation. */
  brainDraft?: string | null;
  queueFull: boolean;
  attachments: Attachment[];
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  notice: string | null;
  setNotice: (s: string | null) => void;
  /** Kill the running turn. Rendered as a labelled pill at the right of the row. */
  onStop?: () => void;
  stopping?: boolean;
  onSend: (
    text: string,
    images: Array<{ url: string; mimeType: string; width: number | null; height: number | null }>,
    files: Array<{ url: string; mimeType: string; name: string }>,
  ) => void;
  taRef: React.RefObject<HTMLTextAreaElement | null>;
  history: string[];
  /** Start a dictation run of this kind (drives DictationDock). */
  onDictate?: (source: DictationSource) => void;
  /** Finish the run — the words stay in the draft. */
  onDictateStop?: () => void;
  /** Throw the run away, including what it put in the draft. */
  onDictateCancel?: () => void;
}>(function ComposeBar({
  sessionId,
  disabled,
  awaitingInput = false,
  sending,
  inFlight,
  brainDraft,
  queueFull,
  attachments,
  setAttachments,
  notice,
  setNotice,
  onStop,
  stopping = false,
  onSend,
  taRef,
  history,
  onDictate,
  onDictateStop,
  onDictateCancel,
}, ref) {
  // Draft is owned here (see note above) so typing doesn't re-render SessionPane.
  const [draft, setDraft] = useState(() => loadDraft(sessionId));
  // Dictation run state (see the handle's beginDictation below). `base: null`
  // means the run has not put a character in the draft yet, so the base is
  // still whatever the user has typed by the time the first sentence lands.
  const dictRef = useRef<DictationClaim | null>(null);
  // Rendered, not just a ref, because hiding the caret is a style. While
  // dictation is running the box is being written INTO by something that is not
  // the user, and a caret parked at the end of it is noise at best: it does not
  // mark where typing will go (nobody is typing), it cannot blink properly
  // because the value changes ~36×/second, and on iOS repeatedly moving the
  // selection surfaces the fat caret handle. So it goes away for the duration.
  const [dictating, setDictating] = useState(false);
  // Whether the textarea has the caret. Two things read it: the press-to-talk
  // layer, which only covers a box nobody is typing in, and the mic button,
  // which is the way to dictate once you ARE typing in it.
  const [focused, setFocused] = useState(false);
  // Persist the draft per session (localStorage writes are cheap for short
  // text). Auto-cleared when the draft empties on send / Escape.
  useEffect(() => { saveDraft(sessionId, draft); }, [sessionId, draft]);

  // Out-of-band draft writes SessionPane still triggers. setText/appendText
  // mirror the old pickPrompt/insertTranscript (focus + caret-to-end + resize);
  // clear/restore mirror the send path's optimistic clear + error restore
  // (restore is a bare value set — no focus/resize — exactly as the old
  // setDraft(prevDraft) on error was).
  useImperativeHandle(ref, () => ({
    setText(text: string) {
      setDraft(text);
      requestAnimationFrame(() => {
        const el = taRef.current;
        if (!el) return;
        el.focus({ preventScroll: true });
        el.setSelectionRange(text.length, text.length);
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 360)}px`;
      });
    },
    appendText(text: string) {
      setDraft((d) => {
        const base = d.trimEnd();
        return base ? `${base} ${text}` : text;
      });
      requestAnimationFrame(() => {
        const el = taRef.current;
        if (!el) return;
        el.focus({ preventScroll: true });
        el.setSelectionRange(el.value.length, el.value.length);
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 360)}px`;
      });
    },
    clear() { setDraft(''); },
    restore(text: string) { setDraft(text); },

    // ── realtime dictation ────────────────────────────────────────────────
    // A run owns a TAIL: the draft is `base + tail`, and the tail is rewritten
    // whole on every change (a sentence closing, a correction landing). Whole,
    // not patched by offset — corrections come back out of order, so the caller
    // rebuilds the string from its segment array and hands it over; there is no
    // arithmetic here to get wrong.
    beginDictation() {
      dictRef.current = newClaim();
      setDictating(true);
    },
    setDictationTail(tail: string) {
      setDraft((d) => {
        const st = dictRef.current;
        if (!st) return d;
        // foldTail is pure and idempotent on the same (claim, draft, tail), which
        // is what makes storing the result back into a ref from inside an updater
        // safe under React's double-invocation.
        const next = foldTail(st, d, tail);
        dictRef.current = next.claim;
        return next.draft;
      });
      requestAnimationFrame(() => {
        const el = taRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 360)}px`;
        // Past the 360px cap the box scrolls instead of growing, and the words
        // are landing at the BOTTOM — without this you would be watching the
        // beginning of a paragraph you finished dictating a minute ago.
        //
        // Note what is NOT here: setSelectionRange. Dragging the caret to the end
        // on every frame is what made it ugly, and it bought nothing — the text
        // is appended by setting `value`, not by typing at a cursor.
        el.scrollTop = el.scrollHeight;
      });
    },
    refineDictationTail(tail: string) {
      setDraft((d) => {
        const st = dictRef.current;
        if (!st) return d;
        const next = replaceTail(st, d, tail);
        dictRef.current = next.claim;
        return next.draft;
      });
      requestAnimationFrame(() => {
        const el = taRef.current;
        if (!el) return;
        // The passage usually gets SHORTER here (that is what stitching does),
        // so the box has to be allowed to shrink as well as grow.
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 360)}px`;
        el.scrollTop = el.scrollHeight;
      });
    },
    dictationBase() {
      return dictRef.current?.base ?? '';
    },
    endDictation(discard = false) {
      const st = dictRef.current;
      dictRef.current = null;
      setDictating(false);
      // Same update that ends the run, so there is no window in which the claim
      // is gone but the words it owns are still in the draft.
      if (discard && st) setDraft((d) => foldTail(st, d, '').draft);
      // Now that the words have stopped arriving, put the caret where someone
      // would want to keep typing. Once, not per frame — and without focusing,
      // which would throw the on-screen keyboard up at someone who just finished
      // deliberately NOT using it.
      requestAnimationFrame(() => {
        const el = taRef.current;
        if (!el) return;
        el.setSelectionRange(el.value.length, el.value.length);
      });
    },
  }), [taRef]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Shell-style sent-message recall: histIdxRef walks `history` (newest last;
  // -1 = the live draft). liveDraftRef stashes what you were typing before you
  // started browsing, so ↓ past the newest restores it.
  const histIdxRef = useRef(-1);
  const liveDraftRef = useRef('');
  const recall = useCallback((text: string) => {
    setDraft(text);
    // setDraft is programmatic here (no onChange fires) — move the caret to the
    // end and re-fit the height ourselves, after the new value paints.
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.selectionStart = el.selectionEnd = el.value.length;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 360)}px`;
    });
  }, [setDraft, taRef]);

  // Auto-resize textarea: clamp height between 1 and 12 rows. While an IME is
  // composing (中文输入法组字中) we skip the height work entirely: reading
  // scrollHeight forces a synchronous reflow mid-composition, which on
  // WebKit/Blink can commit or cancel the composition — leaving the field stuck
  // typing raw English and the IME's Shift 中/英 toggle dead until refocus. The
  // committing input event (isComposing === false) still resizes.
  const onChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    histIdxRef.current = -1; // typing detaches from history browsing
    if ((e.nativeEvent as InputEvent).isComposing) return;
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 360)}px`;
  }, [setDraft]);

  // When the draft is cleared programmatically (after sending — which doesn't
  // fire onChange), the imperatively-set height sticks, leaving the composer
  // tall-but-empty. Collapse it back to one row whenever the draft empties.
  useEffect(() => {
    if (draft === '' && taRef.current) taRef.current.style.height = 'auto';
  }, [draft, taRef]);

  // On mount, size the box to fit a restored draft — no onChange fires for a
  // value loaded from storage, so the height would otherwise stay at one row.
  useEffect(() => {
    const el = taRef.current;
    if (el && el.value) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 360)}px`; }
    // mount-only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Upload one or more files (image or otherwise) to /api/upload; track each via
  // an Attachment record so the UI shows a thumbnail/chip + spinner. Images get
  // an object-URL preview; other files get a generic chip.
  const addFiles = useCallback(async (incoming: File[]) => {
    if (incoming.length === 0) return;
    // Enforce the per-message caps up front so extras are skipped with a visible
    // notice — instead of being accepted and then silently sinking the whole send
    // (chat.send rejects if images > MAX_IMAGES or files > MAX_FILES). Count slots
    // already taken (ready or still uploading; error chips don't occupy one).
    const liveImg = attachments.filter((a) => (a.kind === 'ready' || a.kind === 'uploading') && a.isImage).length;
    const liveFile = attachments.filter((a) => (a.kind === 'ready' || a.kind === 'uploading') && !a.isImage).length;
    let imgSlots = MAX_IMAGES - liveImg;
    let fileSlots = MAX_FILES - liveFile;
    const accepted: File[] = [];
    let droppedImg = 0;
    let droppedFile = 0;
    for (const file of incoming) {
      if (file.type.startsWith('image/')) {
        if (imgSlots > 0) { accepted.push(file); imgSlots -= 1; } else droppedImg += 1;
      } else if (fileSlots > 0) { accepted.push(file); fileSlots -= 1; } else {
        droppedFile += 1;
      }
    }
    if (droppedImg || droppedFile) {
      const parts: string[] = [];
      if (droppedImg) parts.push(`${droppedImg} image${droppedImg > 1 ? 's' : ''} (max ${MAX_IMAGES} per message)`);
      if (droppedFile) parts.push(`${droppedFile} file${droppedFile > 1 ? 's' : ''} (max ${MAX_FILES} per message)`);
      setNotice(`Skipped ${parts.join(' and ')}.`);
    } else {
      setNotice(null);
    }
    if (accepted.length === 0) return;
    for (const file of accepted) {
      const isImage = file.type.startsWith('image/');
      const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
      const name = file.name || (isImage ? 'pasted-image' : 'file');
      // Whitelist non-image extensions client-side so we surface a friendly
      // error chip without a useless upload roundtrip. Server-side
      // /api/upload enforces the same set as defense-in-depth.
      if (!isImage) {
        const ext = getExt(name);
        if (!SAFE_FILE_EXT_SET.has(ext)) {
          setAttachments((prev) => [...prev, { id, kind: 'error', name, error: `unsupported file type${ext ? ` (.${ext})` : ''}` }]);
          continue;
        }
      }
      const previewUrl = isImage ? URL.createObjectURL(file) : null;
      setAttachments((prev) => [...prev, { id, kind: 'uploading', name, isImage, previewUrl }]);
      // Read pixel dims in the browser, in parallel with the upload. The server
      // tries too (sips/identify), but those may be absent on the deploy box —
      // the client read guarantees the chip shows real W×H, not "?×?".
      const clientDimsP = isImage ? readImageDims(file) : Promise.resolve(null);
      try {
        const fd = new FormData();
        fd.append('sessionId', sessionId);
        fd.append('file', file);
        const r = await authedFetch('/api/upload', { method: 'POST', body: fd });
        if (!r.ok) throw new Error(`upload failed (${r.status}): ${await r.text().catch(() => '')}`);
        const data = await r.json() as { url: string; mimeType: string; width: number | null; height: number | null };
        const clientDims = await clientDimsP;
        setAttachments((prev) => prev.map((a) => a.id === id ? { id, kind: 'ready', name, isImage, previewUrl, data: { url: data.url, mimeType: data.mimeType, width: data.width ?? clientDims?.width ?? null, height: data.height ?? clientDims?.height ?? null } } : a));
      } catch (e) {
        setAttachments((prev) => prev.map((a) => a.id === id ? { id, kind: 'error', name, error: e instanceof Error ? e.message : String(e) } : a));
      }
    }
  }, [sessionId, setAttachments, attachments, setNotice]);

  const onPickFiles = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) void addFiles(files);
    e.target.value = ''; // allow re-picking the same file
  }, [addFiles]);

  const onPaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const it of Array.from(items)) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f && f.type.startsWith('image/')) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
  }, [addFiles]);

  const [dragHover, setDragHover] = useState(false);
  const onDragOver = useCallback((e: DragEvent<HTMLFormElement>) => {
    if (Array.from(e.dataTransfer.items).some((it) => it.kind === 'file')) {
      e.preventDefault();
      setDragHover(true);
    }
  }, []);
  const onDragLeave = useCallback(() => setDragHover(false), []);
  const onDrop = useCallback((e: DragEvent<HTMLFormElement>) => {
    e.preventDefault();
    setDragHover(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) void addFiles(files);
  }, [addFiles]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target && 'previewUrl' in target && target.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return prev.filter((a) => a.id !== id);
    });
  }, [setAttachments]);

  const readyAttachments = useMemo(
    () => attachments.filter((a): a is Attachment & { kind: 'ready' } => a.kind === 'ready'),
    [attachments],
  );
  const uploadingCount = attachments.filter((a) => a.kind === 'uploading').length;
  // Occupied slots (ready or uploading; error chips don't count) for the caps caption.
  const imgCount = attachments.filter((a) => (a.kind === 'ready' || a.kind === 'uploading') && a.isImage).length;
  const fileCount = attachments.filter((a) => (a.kind === 'ready' || a.kind === 'uploading') && !a.isImage).length;

  // `override` exists for the press-and-hold send, which fires from an effect a
  // beat after the last word lands: reading the textarea's own value there is
  // exact, where this closure's `draft` is only as fresh as the render the
  // effect was scheduled from.
  const submit = (override?: string) => {
    const text = (override ?? draft).trim();
    // `sending` is deliberately NOT a guard. An in-flight send (~0.2–0.5s,
    // longer with auto-translate) used to swallow an Enter whole — no bubble,
    // no feedback. Now every Enter goes through: onSend puts the bubble up
    // immediately and SessionPane's send chain serializes the actual dispatch,
    // which is what the guard was really for. The draft clearing on send
    // already stops a double-Enter from sending the same text twice.
    if (disabled || queueFull) return;
    // Hold the send until every attachment finishes uploading — otherwise the
    // message goes out with the still-uploading files silently dropped.
    if (uploadingCount > 0) return;
    if (!text && readyAttachments.length === 0) return;
    const images = readyAttachments
      .filter((a) => a.isImage)
      .map((a) => ({ url: a.data.url, mimeType: a.data.mimeType, width: a.data.width, height: a.data.height }));
    const files = readyAttachments
      .filter((a) => !a.isImage)
      .map((a) => ({ url: a.data.url, mimeType: a.data.mimeType, name: a.name }));
    onSend(text, images, files);
    histIdxRef.current = -1;
  };

  // No slash-command menu. This box types AT the agent; it is not a remote
  // keyboard for Claude Code's REPL. A menu of /clear, /model, /exit put the
  // session's own controls one Enter away from a chat message, and each one
  // changed state the dashboard then had to guess at: /model moved the model
  // without moving the column that says which model this session runs, /clear
  // dropped a conversation the timeline still displayed, /exit ended the
  // session under a UI that showed it live. The two that earn their keep are
  // buttons with the state behind them — compact in the header, and the model
  // picker beside the backend chip.

  // The composer NEVER carries the stop control. It used to swap the send button
  // for an identically-styled dark circle whenever a turn was in flight, which
  // made two different gestures land on the same pixels: "tap the round button"
  // meant send at rest and KILL THE RUNNING TURN while it worked — and with a
  // draft typed, stop and send sat side by side as two indistinguishable circles.
  // Stop is back at the right of this row, but as a LABELLED ROSE PILL sitting
  // BESIDE the send circle — never in it, never styled like it. The two
  // properties that made the old arrangement dangerous are both gone: the send
  // button's pixels never change meaning (it still only ever sends), and it
  // never moves when a turn starts, because the textarea is flex-1 and absorbs
  // the pill's width. The 400 ms arm delay survives too — a turn can begin under
  // a finger already travelling toward that corner.
  // See docs/composer-stop-misfire.md.
  const working = inFlight && !disabled;
  // The Brain's in-progress sentence shows only while the box is otherwise empty —
  // the moment you start typing, the composer is yours and the ghost gets out.
  const showBrainGhost = !!brainDraft && draft.length === 0 && !disabled;
  const canSend = !disabled && !awaitingInput && !queueFull && uploadingCount === 0 && (draft.trim().length > 0 || readyAttachments.length > 0);

  // ── press and hold to talk ────────────────────────────────────────────────
  // WeChat's idiom, on the "Ask anything" box: hold it, talk, and where the
  // finger is when it lifts decides what happens — lift → send, slid left →
  // throw away, slid right → drop into the composer to fix first.
  //
  // The press is taken by a TRANSPARENT LAYER over the textarea, not by the
  // textarea itself, and only while the box is empty and unfocused. A long press
  // on a real text field belongs to the platform: iOS answers it with the
  // magnifier and a Paste callout, and there is no reliable way to call that off
  // once it has started. A plain div has no such behaviour, so the layer takes
  // the hold and hands a TAP straight back — it focuses the textarea, which is
  // all tapping an empty box ever did. The moment the box has text or focus the
  // layer is gone and the textarea is an ordinary textarea again.
  //
  // Touch only. On a desktop, click-and-hold on an input is idle fidgeting, not
  // a request to be recorded; the mic button and ⌥ (below) are the way in there.
  const [holdZone, setHoldZone] = useState<HoldZone | null>(null);
  const [holdPhase, setHoldPhase] = useState<HoldPhase>('listening');
  // Released over "send": the run is closing and the words are still settling
  // (the last sentence, then the whole-passage correction). We send when they stop.
  const [holdSending, setHoldSending] = useState(false);
  const [micHint, setMicHint] = useState<string | null>(null);
  const [micArming, setMicArming] = useState(false);
  const cancelPillRef = useRef<HTMLDivElement>(null);
  const editPillRef = useRef<HTMLDivElement>(null);
  // pointerdown/move run ahead of React's re-render, so the gesture keeps its
  // own copy of everything it has to decide from.
  const holdRef = useRef({ id: -1, x: 0, y: 0, live: false, auth: false, bailed: false, zone: 'send' as HoldZone, timer: 0 as unknown as ReturnType<typeof setTimeout> });

  // Touch-primary is a window read, so it can't decide the first (server) render.
  const [touch, setTouch] = useState(false);
  useEffect(() => setTouch(isTouchPrimary()), []);

  // Keep the cached permission answer fresh: pointerdown reads it synchronously
  // to decide whether it may open the mic, and iOS drops the grant ~10 min after
  // capture stops. (Moved here from the old floating mic, unchanged.)
  useEffect(() => {
    void refreshMicPermission();
    const id = setInterval(() => { if (!document.hidden) void refreshMicPermission(); }, 15_000);
    const onVisible = () => { if (!document.hidden) void refreshMicPermission(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  // First-run (and post-expiry) authorization. Fired from the RELEASE so the
  // system alert never lands mid-press — an alert raised under a held finger
  // swallows the touch, and the pointerup that would have ended the run never
  // arrives. requestMicAccess() must run synchronously inside this gesture's own
  // call stack or WebKit stops treating it as user-initiated: do not await
  // anything before it.
  const authorizeMic = useCallback(() => {
    setMicArming(true);
    setMicHint('请允许使用麦克风');
    requestMicAccess()
      .then(() => {
        setMicHint('已授权 · 再按一下开始说话');
        setTimeout(() => setMicHint(null), 2400);
      })
      .catch((e: unknown) => {
        const denied = (e as DOMException)?.name === 'NotAllowedError';
        setMicHint(denied ? '麦克风被拒绝，去系统设置开启' : '麦克风不可用');
        setTimeout(() => setMicHint(null), denied ? 3600 : 2600);
      })
      .finally(() => { setMicArming(false); void refreshMicPermission(); });
  }, []);

  // The mic button beside the box: hands-free dictation straight into the draft.
  // No hold, no zones, nothing to aim at — it just starts adding words, and the
  // ✓ in the same slot (or the bar above) stops it. First press on an
  // unauthorized mic spends itself on the permission ask, same as the hold does.
  const onMicTap = useCallback(() => {
    setMicHint(null);
    if (!canOpenMicSilently()) { authorizeMic(); return; }
    onDictate?.('tap');
  }, [authorizeMic, onDictate]);

  const endHold = useCallback(() => {
    const h = holdRef.current;
    clearTimeout(h.timer);
    h.id = -1;
    h.live = false;
    h.auth = false;
    h.zone = 'send';
    setHoldZone(null);
  }, []);

  const onHoldDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse') return;
    const h = holdRef.current;
    if (h.id !== -1 || micArming) return;
    h.id = e.pointerId;
    h.x = e.clientX;
    h.y = e.clientY;
    h.live = false;
    h.auth = false;
    h.bailed = false;
    h.zone = 'send';
    // Capture so the moves keep coming after the finger leaves this box — it is
    // small and the slide targets are not on it. Wrapped because a pointer that
    // has already been released (or was never a real one) makes this throw, and
    // an exception here would abandon the gesture half-armed.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no live pointer */ }
    h.timer = setTimeout(() => {
      if (h.id === -1 || h.bailed) return;
      h.live = true;
      setHoldZone('send');
      // Not authorized yet? Show the ask instead of recording — opening the mic
      // here would raise the alert under the finger. The release does it.
      if (!canOpenMicSilently()) {
        h.auth = true;
        setHoldPhase('auth');
        return;
      }
      setHoldPhase('listening');
      onDictate?.('hold');
    }, HOLD_MS);
  }, [micArming, onDictate]);

  const onHoldMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const h = holdRef.current;
    if (h.id !== e.pointerId) return;
    const dx = e.clientX - h.x;
    const dy = e.clientY - h.y;
    if (!h.live) {
      // Still deciding. Any real travel means the finger was going somewhere
      // else — give the gesture back rather than starting to record.
      if (Math.hypot(dx, dy) > BAIL_PX) { h.bailed = true; clearTimeout(h.timer); h.id = -1; }
      return;
    }
    if (h.auth) return; // waiting to ask for permission — there are no zones yet
    // Displacement decides, and landing ON a pill decides too, so a finger that
    // aims at the target it can see is not second-guessed. The pill test is
    // gated on having moved at all, or a press that started near a corner would
    // read as "cancel" before the finger did anything.
    const travelled = Math.hypot(dx, dy) > PILL_MIN_PX;
    const onPill = (el: HTMLDivElement | null) => {
      if (!travelled || !el) return false;
      const r = el.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    };
    const zone: HoldZone =
      dx <= -SLIDE_PX || onPill(cancelPillRef.current) ? 'cancel'
      : dx >= SLIDE_PX || onPill(editPillRef.current) ? 'edit'
      : 'send';
    if (zone !== h.zone) { h.zone = zone; setHoldZone(zone); }
  }, []);

  const onHoldUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const h = holdRef.current;
    if (h.id !== e.pointerId) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    const { live, auth, zone, bailed } = h;
    endHold();
    if (!live) {
      // A tap on an empty box is a tap on an empty box: focus it. (Skipped when
      // the finger travelled — that was a scroll passing through.)
      if (!bailed) taRef.current?.focus({ preventScroll: true });
      return;
    }
    if (auth) { authorizeMic(); return; }
    if (zone === 'cancel') { onDictateCancel?.(); return; }
    if (zone === 'edit') {
      onDictateStop?.();
      taRef.current?.focus({ preventScroll: true });
      return;
    }
    // Send. Close the run and hold the overlay up on 'finishing' — the last
    // sentence and the whole-passage correction are still landing, and sending
    // the half of the sentence that had arrived is not what was said.
    setHoldPhase('finishing');
    setHoldZone('send');
    setHoldSending(true);
    onDictateStop?.();
  }, [endHold, authorizeMic, onDictateCancel, onDictateStop, taRef]);

  // The send itself, once the words have stopped moving. `dictating` goes false
  // when the dock tears the run down, which is after the correction has been
  // written into the draft — so this fires exactly once, on the final text.
  const submitRef = useRef(submit);
  // Deliberately no dep array: `submit` closes over the draft, which the
  // dictation rewrites ~36×/second, so a dependency here would re-arm the
  // timeout below on every frame and it would never fire.
  useEffect(() => { submitRef.current = submit; });
  useEffect(() => {
    if (!holdSending) return;
    const fire = () => {
      setHoldSending(false);
      setHoldZone(null);
      submitRef.current(taRef.current?.value ?? '');
    };
    if (!dictating) { fire(); return; }
    // A run that never tears down would otherwise hold the overlay forever (a
    // socket that opened and then went quiet does exactly that). Send what we
    // have rather than trapping the screen.
    const t = setTimeout(fire, 9000);
    return () => clearTimeout(t);
  }, [holdSending, dictating, taRef]);

  // Desktop push-to-talk: hold RIGHT Option (⌥). Capture starts on keydown so
  // the first words aren't clipped; the short arm below only decides whether to
  // KEEP it, and any other key pressed while arming aborts — that's an
  // Option+arrow edit, not talking. (Moved here from the old floating mic.)
  const dictatingRef = useRef(dictating);
  dictatingRef.current = dictating;
  useEffect(() => {
    if (isTouchPrimary()) return; // touch holds the box instead
    const st = { byKey: false, arm: 0 as unknown as ReturnType<typeof setTimeout> };
    const onDown = (ev: KeyboardEvent) => {
      if (ev.code !== 'AltRight') {
        if (st.byKey && st.arm) { clearTimeout(st.arm); st.arm = 0 as never; st.byKey = false; onDictateCancel?.(); }
        return;
      }
      if (ev.repeat || disabled || awaitingInput || dictatingRef.current) return;
      st.byKey = true;
      onDictate?.('hold');
      st.arm = setTimeout(() => { st.arm = 0 as never; }, 180);
    };
    const onUp = (ev: KeyboardEvent) => {
      if (ev.code !== 'AltRight' || !st.byKey) return;
      st.byKey = false;
      if (st.arm) { clearTimeout(st.arm); st.arm = 0 as never; onDictateCancel?.(); return; } // a tap, not talk
      onDictateStop?.();
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, [disabled, awaitingInput, onDictate, onDictateStop, onDictateCancel]);

  // A press that never gets its pointerup — the tab going away mid-hold (iOS
  // kills capture on backgrounding anyway). Without this the run stays open and
  // the overlay owns the screen on return.
  useEffect(() => {
    const bail = () => {
      if (!document.hidden || holdRef.current.id === -1) return;
      const wasLive = holdRef.current.live;
      endHold();
      if (wasLive) onDictateCancel?.();
    };
    document.addEventListener('visibilitychange', bail);
    return () => document.removeEventListener('visibilitychange', bail);
  }, [endHold, onDictateCancel]);

  // When a press MAY start a run: an empty box nobody is typing in.
  const holdIdle = touch && !!onDictate && !disabled && !awaitingInput && !dictating && draft.length === 0 && !focused;
  // Once one HAS started, the layer must stay mounted no matter what those
  // inputs do — and they all change immediately: the words land in the draft,
  // `dictating` goes true. A layer that unmounts under a held finger never
  // delivers its pointermove or its pointerup, so the zones would be dead and
  // the run would never end. Same rule the old floating mic had, for the same
  // reason. `holdZone` is non-null for exactly the life of the gesture.
  const holdable = holdIdle || holdZone !== null;

  return (
    <form
      className={cn('shrink-0 bg-background transition-colors', dragHover && 'bg-accent/30')}
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* pwa-pb-safe: in the installed PWA, the composer's bottom padding grows to
          clear the home indicator (absorbed via max(), not stacked) so the input
          sits snug above it with no empty band. No-op in a normal browser tab. */}
      <div className="mx-auto w-full max-w-3xl px-3 pb-3 pt-1 pwa-pb-safe">
        <Collapse open={!!notice}>
          <button
            type="button"
            onClick={() => setNotice(null)}
            title="dismiss"
            className="mb-2 flex w-full items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-left text-[12px] text-amber-700 dark:text-amber-400 cursor-pointer"
          >
            <span className="flex-1">{notice}</span>
            <X className="h-3.5 w-3.5 shrink-0 opacity-60" />
          </button>
        </Collapse>
        {attachments.length > 0 && (
          <div className="mb-2 space-y-1.5">
            <div className="flex flex-wrap gap-2">
              {attachments.map((a) => (
                <AttachmentChip key={a.id} attachment={a} onRemove={() => removeAttachment(a.id)} />
              ))}
            </div>
            {(imgCount > 0 || fileCount > 0) && (
              <div className="px-0.5 text-[11px] tabular-nums text-muted-foreground/60">
                {imgCount > 0 && (
                  <span className={cn(imgCount >= MAX_IMAGES && 'text-amber-600 dark:text-amber-400')}>{imgCount}/{MAX_IMAGES} images</span>
                )}
                {imgCount > 0 && fileCount > 0 && <span> · </span>}
                {fileCount > 0 && (
                  <span className={cn(fileCount >= MAX_FILES && 'text-amber-600 dark:text-amber-400')}>{fileCount}/{MAX_FILES} files</span>
                )}
              </div>
            )}
          </div>
        )}
        {/* Permission chatter from the mic — "请允许使用麦克风", "已授权 · 再按一下
            开始说话", a denial. Its own line rather than the notice strip above,
            which belongs to attachments and failed sends. */}
        <Collapse open={!!micHint}>
          <div className="mb-2 flex justify-center">
            <span className="rounded-full bg-foreground/85 px-2.5 py-1 text-[11px] font-medium text-background">
              {micHint}
            </span>
          </div>
        </Collapse>
        <div
          className={cn(
            'relative flex items-end gap-1.5 rounded-[26px] border bg-background px-2 py-2 shadow-sm transition-all duration-100 ease-out',
            disabled || awaitingInput
              ? 'border-border opacity-60'
              : dragHover
              ? 'border-foreground/40'
              : 'border-border focus-within:border-foreground/40 focus-within:shadow-md',
          )}
        >
          {/* upload affordance: one + button. accept includes images and a
              whitelist of safe text / code / pdf extensions; binaries /
              archives / executables are rejected client- and server-side. */}
          <input ref={fileInputRef} type="file" accept={FILE_ACCEPT} multiple hidden onChange={onPickFiles} />
          <div className="flex items-center shrink-0 pb-0.5">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || awaitingInput}
              aria-label="attach image or file"
              title="Attach an image or file"
              className="h-9 w-9 inline-flex items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Plus className="h-5 w-5" />
            </button>
          </div>

          {/* The Brain typing, where you would type. Ghosted and pointer-events-none,
              so it reads as "something is being written here" without taking the
              input away — tapping still focuses the real textarea, and typing is
              what takes the conversation back. Hidden the moment you have your own
              draft, because then the box is yours. */}
          {showBrainGhost && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 left-11 right-12 flex items-center overflow-hidden"
            >
              <span className="line-clamp-2 text-base sm:text-[15px] leading-relaxed text-muted-foreground/70">
                {brainDraft}
                <span className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[3px] animate-pulse bg-muted-foreground/70 align-middle" />
              </span>
            </div>
          )}
          {/* The textarea gets a wrapper so the press-to-talk layer can be sized
              to it exactly (absolute inset-0) instead of guessing at the row's
              padding and button widths. flex-1 + min-w-0 moved off the textarea
              and onto the wrapper; the box itself is now w-full inside it. */}
          <div className="relative flex-1 min-w-0">
          <textarea
            ref={taRef}
            value={draft}
            onChange={onChange}
            onPaste={onPaste}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              // Escape belongs to the box you're typing in, never to the turn.
              // SessionPane listens for Esc on `window` to cancel the running
              // turn; without this stopPropagation, clearing a draft — or an IME
              // dismissing a half-typed composition, which is the same keystroke
              // for anyone typing Chinese — also killed the agent mid-sentence.
              if (e.key === 'Escape') {
                e.stopPropagation();
                // Mid-composition (拼音 candidates open) that Esc belongs to the
                // IME — it cancels the candidate, and the draft underneath must
                // survive. Only a plain Esc clears the box.
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                e.preventDefault();
                setDraft('');
                return;
              }
              // Shell-style history recall: ↑ on the first line walks back through
              // the messages you've sent this session; ↓ on the last line walks
              // forward, then restores the draft you were typing. (Skipped during
              // IME composition, where the arrows belong to the candidate window.)
              if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.nativeEvent.isComposing && history.length > 0) {
                const ta = e.currentTarget;
                const onFirstLine = !draft.slice(0, ta.selectionStart ?? 0).includes('\n');
                const onLastLine = !draft.slice(ta.selectionEnd ?? draft.length).includes('\n');
                if (e.key === 'ArrowUp' && onFirstLine) {
                  e.preventDefault();
                  if (histIdxRef.current === -1) liveDraftRef.current = draft;
                  histIdxRef.current = Math.min(histIdxRef.current + 1, history.length - 1);
                  recall(history[history.length - 1 - histIdxRef.current]);
                  return;
                }
                if (e.key === 'ArrowDown' && onLastLine && histIdxRef.current >= 0) {
                  e.preventDefault();
                  histIdxRef.current -= 1;
                  recall(histIdxRef.current < 0 ? liveDraftRef.current : history[history.length - 1 - histIdxRef.current]);
                  return;
                }
              }
              if (e.key !== 'Enter') return;
              // IME composition (中文输入法 etc.): Enter confirms a candidate.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.shiftKey) return;
              // Mobile: let the return key insert a newline (send via button).
              if (isTouchPrimary()) return;
              e.preventDefault();
              submit();
            }}
            placeholder={
              showBrainGhost
                ? ''
                : disabled
                ? 'session is closed'
                : awaitingInput
                ? '↑ respond above to continue'
                : queueFull
                ? `queue full (${QUEUE_LIMIT}) · waiting for current turn`
                : working
                ? 'working… ↵ to queue next'
                : uploadingCount > 0
                ? `uploading ${uploadingCount}…`
                : dictating
                // The box is the only place a hands-free run reports from now,
                // and it says this for the second or two before the first words
                // land on top of it.
                ? 'listening…'
                : touch
                // Only where the gesture exists. On a desktop the box is held
                // by nobody and ⌥ is the way in, so promising a hold would be
                // an instruction that does nothing.
                ? 'Ask anything · hold to talk'
                : 'Ask anything'
            }
            disabled={disabled || awaitingInput}
            rows={1}
            className="no-scrollbar block w-full bg-transparent text-base sm:text-[15px] resize-none outline-none leading-relaxed min-h-[28px] max-h-[360px] overflow-auto py-1.5 text-foreground placeholder:text-muted-foreground/70 disabled:cursor-not-allowed"
            style={dictating ? { caretColor: 'transparent' } : undefined}
          />
          {/* Press-and-hold to talk. Only over an EMPTY, UNFOCUSED box — see the
              note by the gesture. touch-none kills the scroll/zoom the browser
              would otherwise claim mid-hold; select-none and the suppressed
              context menu keep the platform's long-press UI out of it. */}
          {holdable && (
            <div
              aria-hidden="true"
              className="absolute inset-0 touch-none select-none"
              onPointerDown={onHoldDown}
              onPointerMove={onHoldMove}
              onPointerUp={onHoldUp}
              onPointerCancel={onHoldUp}
              onContextMenu={(e) => e.preventDefault()}
            />
          )}
          </div>

          {working && onStop && <StopPill onStop={onStop} stopping={stopping} />}

          {/* Right of the box, one slot. The mic is a TOGGLE — the same pixels
              start the dictation and end it — and while it is listening it is
              lit rather than swapped for some other glyph: the button you
              pressed is the button you press again, and the only thing that
              changed is that it is on. That is also the whole status display
              for a hands-free run now; the words themselves are the rest of it.
              With text typed, the slot is the ✕ it always was. */}
          {(dictating || draft.length === 0) && onDictate && !disabled && !awaitingInput ? (
            <button
              type="button"
              onClick={dictating ? () => onDictateStop?.() : onMicTap}
              disabled={micArming}
              aria-label={dictating ? '结束听写' : '语音输入'}
              title={micHint ?? (dictating ? '正在听 · 点一下结束' : '语音输入 · 说的话直接写进输入框')}
              className={cn(
                'relative h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-full transition-colors cursor-pointer',
                'disabled:cursor-wait disabled:opacity-60',
                dictating
                  ? 'text-rose-500 dark:text-rose-400'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {/* Breathing halo. Deliberately not animate-ping, which scales to
                  twice the button and would wash over the send circle beside it. */}
              {dictating && (
                <span aria-hidden="true" className="absolute inset-0 animate-pulse rounded-full bg-rose-500/15 dark:bg-rose-400/20" />
              )}
              {micArming
                ? <Loader2 className="h-5 w-5 animate-spin" />
                : <Mic className="relative h-5 w-5" />}
            </button>
          ) : draft.length > 0 && !disabled ? (
            <button
              type="button"
              onClick={() => { setDraft(''); taRef.current?.focus({ preventScroll: true }); }}
              aria-label="clear draft"
              title="Clear"
              className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>
          ) : null}

          {/* One button, one meaning, always in the same place: this circle sends.
              Nothing ever takes its slot (see the `working` note above). */}
          <button
            type="submit"
            disabled={!canSend}
            className={cn(
              'h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-full transition-all',
              canSend
                ? 'bg-foreground text-background hover:bg-foreground/90 cursor-pointer shadow-sm'
                : 'bg-muted text-muted-foreground/40 cursor-not-allowed',
            )}
            aria-label={working ? 'queue message' : 'send'}
            title={working ? 'queue (↵)' : canSend ? 'send (↵)' : uploadingCount > 0 ? 'uploading…' : 'type a message'}
          >
            {sending ? <span className="text-sm">…</span> : <ArrowUp className="h-5 w-5" />}
          </button>
        </div>
        <p className="mt-1.5 text-center text-[10px] text-muted-foreground/50 hidden sm:block">
          messages go to the agent&apos;s terminal · ↵ send · ⇧↵ newline · paste or drop images
        </p>
      </div>
      {holdZone && (
        <HoldToTalkOverlay
          zone={holdZone}
          phase={holdPhase}
          text={draft}
          cancelRef={cancelPillRef}
          editRef={editPillRef}
        />
      )}
    </form>
  );
});

// Decode an image file in the browser just far enough to read its pixel size.
// Resolves null on any failure (non-image, decode error) so callers can fall
// back without a try/catch. Independent of server-side sips/identify, which
// may be missing on the deploy box.
// Non-image file extensions accepted by /api/upload. Anything outside this
// list is rejected before the upload roundtrip (and again on the server) —
// keeps loose binaries / executables out (gibberish in context / a security
// concern). Archives ARE allowed: stored as-is, the gateway hands the agent an
// "extract via Bash" instruction instead of Read'ing them. Mirror of
// `SAFE_FILE_EXT_SET` in apps/dashboard/src/app/api/upload/route.ts.
const SAFE_FILE_EXTS = [
  // text & docs
  'txt','md','markdown','rtf','log','pdf',
  // data / config
  'json','yaml','yml','toml','ini','conf','env','xml','html','svg','csv','tsv','sql',
  // source
  'ts','tsx','js','jsx','mjs','cjs','py','rb','php','go','rs',
  'c','cpp','cc','cxx','h','hpp','java','kt','swift','scala','clj','ex','exs',
  'sh','bash','zsh','fish','ps1','dart','lua','r',
  // archives — stored as-is; the agent extracts them via Bash (never Read'd)
  'zip','tar','gz','tgz','bz2','tbz2','xz','txz','7z','rar','zst',
  // office docs — converted agent-side via Bash (textutil / python / unzip)
  'docx','xlsx','pptx','doc','xls','ppt','odt','ods','odp',
  // audio — stored as-is; the agent transcribes / inspects via Bash (whisper / ffmpeg)
  'mp3','m4a','wav','ogg','flac','aac',
  // video — stored as-is; the agent inspects / extracts frames / transcribes via Bash (ffmpeg / ffprobe)
  'mp4','mov','m4v','webm','mkv','avi','mpeg','mpg','3gp','wmv',
] as const;
const SAFE_FILE_EXT_SET = new Set<string>(SAFE_FILE_EXTS);
// `<input accept>` value: `image/*` + every whitelisted file extension.
const FILE_ACCEPT = 'image/*,' + SAFE_FILE_EXTS.map((e) => '.' + e).join(',');

// Per-message attachment caps — MUST match the server's chat.send zod .max(...).
// The composer enforces them so extras are skipped with a visible notice instead of
// silently failing the send (chat.send rejects the whole message if either is over).
const MAX_IMAGES = 20;
const MAX_FILES = 10;

function getExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

function readImageDims(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const ok = img.naturalWidth > 0 && img.naturalHeight > 0;
      URL.revokeObjectURL(url);
      resolve(ok ? { width: img.naturalWidth, height: img.naturalHeight } : null);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// Sub-label under an attachment's filename. Real pixel dims for images (read
// client-side, so it survives a server without sips/identify); a type hint for
// everything else — never a bogus "?×?".
function readyLabel(a: Extract<Attachment, { kind: 'ready' }>): string {
  if (a.data.width && a.data.height) return `${a.data.width}×${a.data.height}`;
  if (a.isImage) return 'image';
  const sub = a.data.mimeType.split('/')[1];
  if (sub && sub !== 'octet-stream') return sub;
  const ext = a.name.includes('.') ? a.name.split('.').pop()! : '';
  return ext || 'file';
}

function AttachmentChip({ attachment: a, onRemove }: { attachment: Attachment; onRemove: () => void }) {
  const previewUrl = 'previewUrl' in a ? a.previewUrl : null;
  const [lightbox, setLightbox] = useState(false);
  return (
    <div className="relative group inline-flex items-center gap-2 rounded-md border border-border bg-background px-1.5 py-1 text-[11px] font-mono animate-in fade-in-0 zoom-in-95 duration-100">
      {previewUrl ? (
        <button type="button" onClick={() => setLightbox(true)} aria-label="preview image" className="shrink-0 cursor-zoom-in">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewUrl} alt={a.name} className={cn(
            'h-10 w-10 rounded object-cover',
            a.kind === 'uploading' && 'opacity-50',
            a.kind === 'error' && 'opacity-30 grayscale',
          )} />
        </button>
      ) : (
        <div className="h-10 w-10 rounded bg-muted text-muted-foreground/70 flex items-center justify-center">
          {a.kind === 'error' ? '!' : <FileText className="h-5 w-5" />}
        </div>
      )}
      <div className="min-w-0 max-w-[120px]">
        <div className="truncate text-foreground/80">{a.name}</div>
        <div className={cn(
          'text-[10px] tabular-nums',
          a.kind === 'uploading' && 'text-muted-foreground',
          a.kind === 'ready' && 'text-emerald-600',
          a.kind === 'error' && 'text-rose-500',
        )}>
          {a.kind === 'uploading' ? 'uploading…' : a.kind === 'error' ? a.error.slice(0, 40) : readyLabel(a)}
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label="remove attachment"
        className="opacity-60 hover:opacity-100 hover:text-rose-500 transition-[opacity,color] px-1 text-xs cursor-pointer"
      >
        ×
      </button>
      {previewUrl && <ImageLightbox open={lightbox} onOpenChange={setLightbox} url={previewUrl} alt={a.name} />}
    </div>
  );
}
