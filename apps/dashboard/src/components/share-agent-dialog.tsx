'use client';

// "Share" button + dialog on an agent's detail header (owner-only — hidden in a
// scoped session). Mints a per-agent share link: whoever opens it lands in a
// dashboard scoped to ONLY this agent. The token is shown ONCE (only its hash is
// stored), so the dialog displays the URL right after generate/regenerate and
// otherwise just reports that a link is active + offers regenerate / revoke.

import { useState } from 'react';
import { Share2, X, Copy, Check, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { relTime } from '@/lib/format';
import { Overlay } from '@/components/overlay';
import { Button } from '@/components/ui/button';

export function ShareAgentButton({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`share ${name}`}
        aria-label={`share ${name}`}
        className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
      >
        <Share2 className="h-3.5 w-3.5" />
      </button>
      {open && <ShareAgentDialog name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

function ShareAgentDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const utils = trpc.useUtils();
  const get = trpc.share.get.useQuery({ agentName: name });
  const create = trpc.share.create.useMutation({ onSuccess: () => utils.share.get.invalidate() });
  const regenerate = trpc.share.regenerate.useMutation({ onSuccess: () => utils.share.get.invalidate() });
  const revoke = trpc.share.revoke.useMutation({ onSuccess: () => utils.share.get.invalidate() });

  // The plaintext token lives only in this component's state, only after a
  // generate/regenerate this session — never refetched (the server stores a hash).
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const url = token ? `${window.location.origin}/s/${token}` : null;
  const busy = create.isPending || regenerate.isPending || revoke.isPending;
  const err = create.error || regenerate.error || revoke.error;

  const doCreate = async () => setToken((await create.mutateAsync({ agentName: name })).token);
  const doRegen = async () => setToken((await regenerate.mutateAsync({ agentName: name })).token);
  const doRevoke = async () => { await revoke.mutateAsync({ agentName: name }); setToken(null); };
  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard denied — the field is selectable as a fallback */ }
  };

  return (
    <Overlay onClose={onClose} panelClassName="w-full max-w-md">
      {(close) => (
        <div className="rounded-xl border border-border bg-card text-card-foreground p-5 shadow-xl space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                <Share2 className="size-4" /> Share <span className="font-mono">{name}</span>
              </h2>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                Anyone with the link gets full operation of <span className="font-medium text-foreground/80">this agent only</span> — chat, files, and schedules — and can&apos;t see your other agents or anything else on this machine. Only share with people you trust.
              </p>
            </div>
            <button type="button" onClick={close} aria-label="close" className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
              <X className="size-4" />
            </button>
          </div>

          {url ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={url}
                  onFocus={(e) => e.currentTarget.select()}
                  className="flex-1 min-w-0 rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs"
                />
                <Button size="sm" variant="outline" onClick={copy}>
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <p className="text-[11px] text-amber-600">Copy it now — it won&apos;t be shown again. Regenerate makes a fresh link (and kills this one).</p>
            </div>
          ) : get.isPending ? (
            <div className="text-xs text-muted-foreground">loading…</div>
          ) : get.data?.exists ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                A share link is active{get.data.lastUsedAt ? ` · last opened ${relTime(get.data.lastUsedAt)}` : ' · not opened yet'}. The link
                isn&apos;t stored — regenerate to get a fresh copyable one.
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={busy} onClick={doRegen}>
                  {regenerate.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Regenerate
                </Button>
                <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" disabled={busy} onClick={doRevoke}>
                  {revoke.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />} Revoke
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" disabled={busy} onClick={doCreate}>
              {create.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Share2 className="size-3.5" />} Generate share link
            </Button>
          )}

          {err && <p className="text-[11px] text-destructive">{err.message}</p>}
        </div>
      )}
    </Overlay>
  );
}
