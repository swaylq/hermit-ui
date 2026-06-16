'use client';

// Registers the service worker and offers a dismissible "install to desktop"
// affordance. On Chrome/Edge/Android it drives the native beforeinstallprompt; on
// iOS Safari (which has no such event) it shows the manual Share → Add to Home
// Screen hint. Hidden entirely when already running standalone (installed), and
// stays dismissed via localStorage once the user closes it.

import { useEffect, useState } from 'react';
import { Download, X, Share } from 'lucide-react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'pwa-install-dismissed-v1';

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [iosHint, setIosHint] = useState(false);
  const [show, setShow] = useState(false);

  useEffect(() => {
    // Register the SW regardless of the install UI (it makes the app installable
    // and provides the offline fallback).
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    // Already installed (running standalone)? Never nag.
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (standalone) return;

    let dismissed = false;
    try { dismissed = localStorage.getItem(DISMISS_KEY) === '1'; } catch { /* private mode */ }
    if (dismissed) return;

    const onBIP = (e: Event) => {
      e.preventDefault(); // stash it; we trigger the prompt from our button
      setDeferred(e as BeforeInstallPromptEvent);
      setShow(true);
    };
    const onInstalled = () => { setShow(false); setDeferred(null); };
    window.addEventListener('beforeinstallprompt', onBIP);
    window.addEventListener('appinstalled', onInstalled);

    // iOS Safari: no beforeinstallprompt — offer manual instructions instead.
    const ua = navigator.userAgent;
    const isIOS = /iphone|ipad|ipod/i.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS
    const isSafari = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(ua);
    // One-time, mount-only platform check (empty deps — cannot cascade).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isIOS && isSafari) { setIosHint(true); setShow(true); }

    return () => {
      window.removeEventListener('beforeinstallprompt', onBIP);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (!show) return null;

  function dismiss() {
    setShow(false);
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* private mode */ }
  }
  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    try { await deferred.userChoice; } catch { /* ignore */ }
    setDeferred(null);
    setShow(false);
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pointer-events-none">
      <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-border bg-background/95 backdrop-blur px-3 py-2 shadow-lg w-full max-w-md">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icon-192.png" alt="" className="h-9 w-9 rounded-lg shrink-0" />
        {iosHint ? (
          <p className="flex-1 min-w-0 text-xs text-foreground/80 leading-snug">
            安装到主屏幕：点 <Share className="inline h-3.5 w-3.5 -mt-0.5" /> 分享，选「添加到主屏幕」。
          </p>
        ) : (
          <div className="flex-1 min-w-0 text-xs leading-snug">
            <span className="font-medium text-foreground">安装 asst 到桌面</span>
            <span className="block text-muted-foreground">像原生应用一样独立窗口打开。</span>
          </div>
        )}
        {!iosHint && (
          <button
            onClick={install}
            className="shrink-0 inline-flex items-center gap-1 rounded-md bg-foreground text-background text-xs font-medium px-2.5 py-1.5 hover:opacity-90"
          >
            <Download className="h-3.5 w-3.5" /> 安装
          </button>
        )}
        <button onClick={dismiss} aria-label="关闭" className="shrink-0 text-muted-foreground hover:text-foreground p-1">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
