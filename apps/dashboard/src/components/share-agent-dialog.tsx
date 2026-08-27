'use client';

// "Share" button + dialog on an agent's detail header (owner-only — hidden in a
// scoped session). Mints a per-agent share link: whoever opens it lands in a
// dashboard scoped to ONLY this agent. A PRIVATE link's token is shown ONCE (only
// its hash is stored). A "Public — open to the internet" link is deterministic
// (no password) and is created only after the owner confirms a privacy warning.

import { useState } from 'react';
import { Share2, X, Copy, Check, Loader2, RefreshCw, Trash2, AlertTriangle, Globe } from 'lucide-react';
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
  // generate/regenerate this session — never refetched for PRIVATE links (the
  // server stores a hash). A PUBLIC link's token is deterministic (not a secret),
  // so share.get returns it and it can be shown / re-copied any time.
  const [token, setToken] = useState<string | null>(null);
  const [tokenPublic, setTokenPublic] = useState(false);
  const [copied, setCopied] = useState(false);

  // "Public — open to the internet" checkbox + its confirm gate. The checkbox only
  // sticks after the owner confirms the privacy warning (wantPublic stays false on
  // cancel). `confirmPublic` swaps the panel for the warning, a second step.
  const [wantPublic, setWantPublic] = useState(false);
  const [confirmPublic, setConfirmPublic] = useState(false);

  const freshUrl = token ? `${window.location.origin}/s/${token}` : null;
  const activePublicUrl = get.data?.isPublic && get.data.publicToken ? `${window.location.origin}/s/${get.data.publicToken}` : null;
  const busy = create.isPending || regenerate.isPending || revoke.isPending;
  const err = create.error || regenerate.error || revoke.error;

  const doCreate = async () => {
    const r = await create.mutateAsync({ agentName: name, public: wantPublic });
    setToken(r.token);
    setTokenPublic(r.isPublic);
    setWantPublic(false);
  };
  const doRegen = async () => {
    const r = await regenerate.mutateAsync({ agentName: name });
    setToken(r.token);
    setTokenPublic(r.isPublic);
  };
  const doRevoke = async () => {
    await revoke.mutateAsync({ agentName: name });
    setToken(null);
    setTokenPublic(false);
    setWantPublic(false);
  };
  const copy = async (text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard denied — the field is selectable as a fallback */ }
  };

  const togglePublic = (checked: boolean) => {
    if (checked) setConfirmPublic(true); // gate the "on" state behind a confirm
    else setWantPublic(false);
  };

  return (
    <Overlay onClose={onClose} panelClassName="w-full max-w-md">
      {(close) =>
        confirmPublic ? (
          <div className="rounded-xl border border-border bg-card text-card-foreground p-5 shadow-xl space-y-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="size-5 shrink-0 text-amber-500" />
              <div className="space-y-1.5">
                <h2 className="text-sm font-semibold">Make this link public?</h2>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Anyone on the internet with the link can then use <span className="font-medium text-foreground/80">{name}</span> — chat, files, and schedules — <span className="font-medium text-foreground/80">with no password</span>. It becomes publicly reachable, so make sure nothing private will leak. You can revoke it later to close access.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => { setConfirmPublic(false); setWantPublic(false); }}>
                Cancel
              </Button>
              <Button size="sm" variant="destructive" onClick={() => { setConfirmPublic(false); setWantPublic(true); }}>
                <Globe className="size-3.5" /> Make public
              </Button>
            </div>
          </div>
        ) : (
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

            {freshUrl ? (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={freshUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    className="flex-1 min-w-0 rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs"
                  />
                  <Button size="sm" variant="outline" onClick={() => copy(freshUrl)}>
                    {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
                {tokenPublic ? (
                  <p className="text-[11px] text-amber-600">Public link — anyone with this URL can use the agent with no password.</p>
                ) : (
                  <p className="text-[11px] text-amber-600">Copy it now — it won&apos;t be shown again. Regenerate makes a fresh link (and kills this one).</p>
                )}
              </div>
            ) : get.isPending ? (
              <div className="text-xs text-muted-foreground">loading…</div>
            ) : get.data?.exists ? (
              get.data.isPublic ? (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <input
                      readOnly
                      value={activePublicUrl ?? ''}
                      onFocus={(e) => e.currentTarget.select()}
                      className="flex-1 min-w-0 rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs"
                    />
                    <Button size="sm" variant="outline" onClick={() => copy(activePublicUrl ?? '')}>
                      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                  <p className="text-[11px] text-amber-600">
                    Public link is active{get.data.lastUsedAt ? ` · last opened ${relTime(get.data.lastUsedAt)}` : ' · not opened yet'} — anyone with the URL can use it, no password.
                  </p>
                  <div className="flex justify-end">
                    <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" disabled={busy} onClick={doRevoke}>
                      {revoke.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />} Revoke
                    </Button>
                  </div>
                </div>
              ) : (
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
              )
            ) : (
              <div className="space-y-3">
                <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-muted/30 p-2.5">
                  <input
                    type="checkbox"
                    checked={wantPublic}
                    onChange={(e) => togglePublic(e.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5 shrink-0"
                  />
                  <span className="min-w-0 text-xs">
                    <span className="flex items-center gap-1.5 font-medium">
                      <Globe className="size-3.5" /> Public — open to the internet
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                      No password: anyone with the link can use this agent. Off by default.
                    </span>
                  </span>
                </label>
                <Button size="sm" disabled={busy} onClick={doCreate}>
                  {create.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Share2 className="size-3.5" />} Generate share link
                </Button>
              </div>
            )}

            {err && <p className="text-[11px] text-destructive">{err.message}</p>}
          </div>
        )
      }
    </Overlay>
  );
}
