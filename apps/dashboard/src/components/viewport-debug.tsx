'use client';

// TEMPORARY on-device diagnostic for the iOS standalone keyboard / bottom-gap
// issue. Shows live viewport metrics + a Copy button so the exact values (after
// the keyboard cycle) can be pasted back. Renders ONLY in an installed PWA
// (display-mode: standalone) or when the URL contains `vpdebug`. Remove once the
// bottom-gap issue is resolved.

import { useEffect, useRef, useState } from 'react';

export function ViewportDebug() {
  const [text, setText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const latest = useRef('');
  const maxIH = useRef(0);
  const maxVV = useRef(0);

  useEffect(() => {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    const forced = /vpdebug/.test(window.location.search + window.location.hash);
    if (!standalone && !forced) return;

    // probe to resolve env(safe-area-inset-*)
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;visibility:hidden;padding-bottom:env(safe-area-inset-bottom);padding-top:env(safe-area-inset-top)';
    document.body.appendChild(probe);

    const vv = window.visualViewport;
    const render = () => {
      const root = document.documentElement;
      const appH = getComputedStyle(root).getPropertyValue('--app-h').trim() || '(unset)';
      const shell = document.querySelector('.app-h.flex.overflow-hidden') as HTMLElement | null;
      const shellH = shell ? Math.round(shell.getBoundingClientRect().height) : '?';
      const ps = getComputedStyle(probe);
      if (window.innerHeight > maxIH.current) maxIH.current = window.innerHeight;
      if (vv && vv.height > maxVV.current) maxVV.current = Math.round(vv.height);
      const t =
        `vv.height=${vv ? Math.round(vv.height) : '?'} (max=${maxVV.current})  vv.offsetTop=${vv ? Math.round(vv.offsetTop) : '?'}  vv.pageTop=${vv ? Math.round(vv.pageTop) : '?'}\n` +
        `innerHeight=${window.innerHeight} (max=${maxIH.current})  screen.height=${window.screen.height}\n` +
        `--app-h=${appH}  shellH=${shellH}\n` +
        `scrollY=${Math.round(window.scrollY)}  docClientH=${root.clientHeight}  docScrollH=${root.scrollHeight}\n` +
        `safeTop=${ps.paddingTop}  safeBottom=${ps.paddingBottom}\n` +
        `ua=${navigator.userAgent}`;
      latest.current = t;
      setText(t);
    };
    const raf = requestAnimationFrame(render); // initial (off the effect body — no sync setState)
    const iv = window.setInterval(render, 250);
    window.addEventListener('resize', render);
    window.addEventListener('scroll', render);
    vv?.addEventListener('resize', render);
    vv?.addEventListener('scroll', render);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(iv);
      window.removeEventListener('resize', render);
      window.removeEventListener('scroll', render);
      vv?.removeEventListener('resize', render);
      vv?.removeEventListener('scroll', render);
      probe.remove();
    };
  }, []);

  if (text == null) return null;

  const copy = async () => {
    const t = latest.current;
    let ok = false;
    try {
      await navigator.clipboard.writeText(t);
      ok = true;
    } catch {
      // fallback for non-secure / older WebViews
      try {
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch { /* ignore */ }
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 'env(safe-area-inset-top)',
        left: 0,
        right: 0,
        zIndex: 99999,
        background: 'rgba(0,0,0,0.85)',
        color: '#34d399',
        font: '10px/1.45 ui-monospace, monospace',
        padding: '3px 6px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
        <span style={{ color: '#fff', fontWeight: 600 }}>VP DEBUG</span>
        <button
          onClick={copy}
          style={{
            appearance: 'none',
            border: '1px solid #34d399',
            background: copied ? '#34d399' : 'transparent',
            color: copied ? '#000' : '#34d399',
            font: '11px ui-monospace, monospace',
            padding: '3px 12px',
            borderRadius: 5,
            cursor: 'pointer',
          }}
        >
          {copied ? '✓ 已复制' : '复制'}
        </button>
      </div>
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{text}</pre>
    </div>
  );
}
