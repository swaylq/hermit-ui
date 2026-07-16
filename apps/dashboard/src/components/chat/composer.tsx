'use client';

// The chat composer and its queue strip. Extracted verbatim from chat/page.tsx
// (P2-3); behaviour identical. ComposeBar (textarea + send + attachments +
// slash-command suggestions) and QueueBar (the waiting-dispatch strip) are the
// two exports, both consumed by SessionPane; AttachmentChip / readyLabel /
// getExt / readImageDims / SLASH_COMMANDS and the SAFE_FILE_* / MAX_* file
// constants are module-private, used only within this cluster.

import { useState, useRef, useCallback, useEffect, useMemo, type ChangeEvent, type ClipboardEvent, type DragEvent } from 'react';
import { cn } from '@/lib/utils';
import { trpc } from '@/lib/trpc';
import { authedFetch } from '@/lib/asst-fetch';
import { isTouchPrimary } from '@/lib/save-file';
import { QUEUE_LIMIT } from '@/lib/chat-queue';
import { ImageLightbox } from '@/components/ui/image-lightbox';
import { Plus, ArrowUp, FileText, X } from 'lucide-react';
import { msgText, type Attachment } from '@/components/chat/lib';

// Claude Code built-in slash commands the composer suggests when the user
// types "/". Picking one fills the draft; sending sends it as a normal user
// message — it lands in the agent's REPL via tmux send-keys and claude runs
// it just like a typed slash command. Interactive ones (/help, /memory, etc.)
// are intentionally omitted: they open TUI modals that hang the headless pane.
const SLASH_COMMANDS: Array<{ name: string; hint: string; needsArgs?: boolean }> = [
  { name: '/compact',  hint: '压缩上下文' },
  { name: '/clear',    hint: '清空对话' },
  { name: '/status',   hint: '当前会话状态' },
  { name: '/model',    hint: '切换模型（如 opus / sonnet / fable）', needsArgs: true },
  { name: '/goal',     hint: '设置 / 查看目标' },
  { name: '/exit',     hint: '退出会话' },
  { name: '/logout',   hint: '退出登录' },
];

// The waiting-dispatch queue strip, shown between the LoopBar and the composer
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
  if (items.length === 0) return null;
  return (
    <div className="mx-auto w-full max-w-3xl px-3">
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
              <span className="min-w-0 flex-1 truncate text-foreground/80">{msgText(it.content) || '（附件）'}</span>
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
    </div>
  );
}

export function ComposeBar({
  sessionId,
  disabled,
  awaitingInput = false,
  sending,
  inFlight,
  queueFull,
  stopping,
  onStop,
  draft,
  setDraft,
  attachments,
  setAttachments,
  notice,
  setNotice,
  onSend,
  taRef,
  history,
}: {
  sessionId: string;
  disabled: boolean;
  awaitingInput?: boolean;
  sending: boolean;
  inFlight: boolean;
  queueFull: boolean;
  stopping: boolean;
  onStop: () => void;
  draft: string;
  setDraft: (s: string) => void;
  attachments: Attachment[];
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  notice: string | null;
  setNotice: (s: string | null) => void;
  onSend: (
    text: string,
    images: Array<{ url: string; mimeType: string; width: number | null; height: number | null }>,
    files: Array<{ url: string; mimeType: string; name: string }>,
  ) => void;
  taRef: React.RefObject<HTMLTextAreaElement | null>;
  history: string[];
}) {
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

  // Auto-resize textarea: clamp height between 1 and 12 rows.
  const onChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    histIdxRef.current = -1; // typing detaches from history browsing
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

  const submit = () => {
    const text = draft.trim();
    if (sending || disabled || queueFull) return;
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
    noteSlashCommand(text);
  };

  // ── Slash-command picker ───────────────────────────────────────────────
  // Open whenever the draft is "/" followed only by letters (no whitespace
  // yet — once the user starts typing args the picker gets out of the way).
  // ↑/↓ navigate, Enter sends (or picks if the command needs args), Tab picks
  // without sending, Esc clears.
  const slashPrefix = /^\/[a-zA-Z]*$/.test(draft) ? draft.toLowerCase() : null;
  const slashFiltered = useMemo(
    () => (slashPrefix == null ? [] : SLASH_COMMANDS.filter((c) => c.name.startsWith(slashPrefix))),
    [slashPrefix],
  );
  const slashOpen = slashFiltered.length > 0;
  const [slashIdx, setSlashIdx] = useState(0);
  useEffect(() => { setSlashIdx(0); }, [slashPrefix]);
  const pickCommand = useCallback((cmd: (typeof SLASH_COMMANDS)[number]) => {
    setDraft(cmd.needsArgs ? cmd.name + ' ' : cmd.name);
    taRef.current?.focus();
  }, [setDraft, taRef]);

  // Most slash commands (/status, /clear, /model, …) print to claude's TUI
  // panel but never write to the JSONL we tail — so without follow-up the
  // dashboard sits forever on "assistant is working…" (lastMsg.role === 'user').
  // Right after dispatching, append a tiny "↳ sent /X" system note: it both
  // confirms the command landed AND flips the in-flight heuristic.
  const appendSystemNote = trpc.chat.appendSystemNote.useMutation();
  const noteSlashCommand = useCallback((text: string) => {
    const m = /^\/(\w+)/.exec(text.trim());
    if (m) appendSystemNote.mutate({ sessionId, text: `↳ sent /${m[1]}` });
  }, [appendSystemNote, sessionId]);

  // While the assistant is producing output, swap the send button for a stop.
  const showStop = inFlight && !disabled;
  const canSend = !sending && !disabled && !awaitingInput && !queueFull && uploadingCount === 0 && (draft.trim().length > 0 || readyAttachments.length > 0);

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
        {notice && (
          <button
            type="button"
            onClick={() => setNotice(null)}
            title="dismiss"
            className="mb-2 flex w-full items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-left text-[12px] text-amber-700 dark:text-amber-400 cursor-pointer"
          >
            <span className="flex-1">{notice}</span>
            <X className="h-3.5 w-3.5 shrink-0 opacity-60" />
          </button>
        )}
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
        <div
          className={cn(
            'relative flex items-end gap-1.5 rounded-[26px] border bg-background px-2 py-2 shadow-sm transition-all duration-100 ease-out',
            disabled || awaitingInput
              ? 'border-border opacity-60'
              : showStop
              ? 'border-rose-500/40'
              : dragHover
              ? 'border-foreground/40'
              : 'border-border focus-within:border-foreground/40 focus-within:shadow-md',
          )}
        >
          {slashOpen && (
            <div className="absolute bottom-full left-0 right-0 mb-2 rounded-xl border border-border bg-popover shadow-lg p-1 z-30 max-h-72 overflow-y-auto">
              {slashFiltered.map((c, i) => (
                <button
                  key={c.name}
                  type="button"
                  onMouseDown={(ev) => { ev.preventDefault(); pickCommand(c); }}
                  onMouseEnter={() => setSlashIdx(i)}
                  className={cn(
                    'w-full text-left flex items-baseline gap-3 px-2.5 py-1.5 rounded-md text-sm transition-colors cursor-pointer',
                    i === slashIdx ? 'bg-accent' : 'hover:bg-accent/50',
                  )}
                >
                  <span className="font-mono font-medium text-foreground shrink-0">{c.name}</span>
                  <span className="text-xs text-muted-foreground truncate">{c.hint}</span>
                </button>
              ))}
            </div>
          )}
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

          <textarea
            ref={taRef}
            value={draft}
            onChange={onChange}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (slashOpen) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx((i) => Math.min(slashFiltered.length - 1, i + 1)); return; }
                if (e.key === 'ArrowUp')   { e.preventDefault(); setSlashIdx((i) => Math.max(0, i - 1)); return; }
                if (e.key === 'Tab')       { e.preventDefault(); pickCommand(slashFiltered[slashIdx]); return; }
                if (e.key === 'Escape')    { e.preventDefault(); setDraft(''); return; }
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229 && !isTouchPrimary()) {
                  e.preventDefault();
                  const cmd = slashFiltered[slashIdx];
                  if (cmd.needsArgs) pickCommand(cmd);
                  else if (!sending && !disabled && !inFlight && !awaitingInput) { onSend(cmd.name, [], []); noteSlashCommand(cmd.name); }
                  return;
                }
              }
              // Shell-style history recall: ↑ on the first line walks back through
              // the messages you've sent this session; ↓ on the last line walks
              // forward, then restores the draft you were typing. (The slash picker
              // claims ↑/↓ above when open; skip during IME composition.)
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
              disabled
                ? 'session is closed'
                : awaitingInput
                ? '↑ respond above to continue'
                : queueFull
                ? `queue full (${QUEUE_LIMIT}) · waiting for current turn`
                : showStop
                ? 'working… ↵ to queue next'
                : uploadingCount > 0
                ? `uploading ${uploadingCount}…`
                : 'Ask anything'
            }
            disabled={disabled || awaitingInput}
            rows={1}
            className="flex-1 bg-transparent text-base sm:text-[15px] resize-none outline-none leading-relaxed min-h-[28px] max-h-[360px] overflow-auto py-1.5 text-foreground placeholder:text-muted-foreground/70 disabled:cursor-not-allowed"
          />

          {/* Clear the draft once there's text — mirrors the x on the other inputs. */}
          {draft.length > 0 && !disabled && (
            <button
              type="button"
              onClick={() => { setDraft(''); taRef.current?.focus(); }}
              aria-label="clear draft"
              title="Clear"
              className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>
          )}

          {showStop && (
            <button
              type="button"
              onClick={onStop}
              disabled={stopping}
              className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-full cursor-pointer bg-foreground text-background hover:bg-foreground/90 disabled:opacity-50 disabled:cursor-wait transition-colors"
              aria-label={stopping ? 'stopping' : 'stop assistant turn'}
              title={stopping ? 'stopping…' : 'stop assistant turn'}
            >
              <span className="h-3 w-3 rounded-[3px] bg-current" aria-hidden="true" />
            </button>
          )}
          {(!showStop || canSend) && (
            <button
              type="submit"
              disabled={!canSend}
              className={cn(
                'h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-full transition-all',
                canSend
                  ? 'bg-foreground text-background hover:bg-foreground/90 cursor-pointer shadow-sm'
                  : 'bg-muted text-muted-foreground/40 cursor-not-allowed',
              )}
              aria-label={inFlight ? 'queue message' : 'send'}
              title={inFlight ? 'queue (↵)' : canSend ? 'send (↵)' : uploadingCount > 0 ? 'uploading…' : 'type a message'}
            >
              {sending ? <span className="text-sm">…</span> : <ArrowUp className="h-5 w-5" />}
            </button>
          )}
        </div>
        <p className="mt-1.5 text-center text-[10px] text-muted-foreground/50 hidden sm:block">
          messages go to the agent&apos;s terminal · ↵ send · ⇧↵ newline · paste or drop images
        </p>
      </div>
    </form>
  );
}

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
    <div className="relative group inline-flex items-center gap-2 rounded-md border border-border bg-background px-1.5 py-1 text-[11px] font-mono">
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
        className="opacity-60 hover:opacity-100 hover:text-rose-500 px-1 text-xs cursor-pointer"
      >
        ×
      </button>
      {previewUrl && <ImageLightbox open={lightbox} onOpenChange={setLightbox} url={previewUrl} alt={a.name} />}
    </div>
  );
}
