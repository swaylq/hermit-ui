'use client';

// TEMPORARY on-device diagnostic for the iOS standalone keyboard / bottom-gap
// issue. Shows live viewport metrics so a screenshot after the keyboard cycle
// reveals exactly which value is stuck. Renders ONLY in an installed PWA
// (display-mode: standalone) or when the URL contains `vpdebug`. Remove once the
// bottom-gap issue is resolved.

import { useEffect, useState } from 'react';

export function ViewportDebug() {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    const forced = /vpdebug/.test(window.location.search + window.location.hash);
    if (!standalone && !forced) return;

    // probe to resolve env(safe-area-inset-bottom)
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
      setText(
        `VP DEBUG  (standalone=${standalone})\n` +
        `vv.height=${vv ? Math.round(vv.height) : '?'}  vv.offsetTop=${vv ? Math.round(vv.offsetTop) : '?'}  vv.pageTop=${vv ? Math.round(vv.pageTop) : '?'}\n` +
        `innerHeight=${window.innerHeight}  --app-h=${appH}  shellH=${shellH}\n` +
        `scrollY=${Math.round(window.scrollY)}  docClientH=${root.clientHeight}  docScrollH=${root.scrollHeight}\n` +
        `safeTop=${ps.paddingTop}  safeBottom=${ps.paddingBottom}`,
      );
    };
    render();
    const iv = window.setInterval(render, 250);
    window.addEventListener('resize', render);
    window.addEventListener('scroll', render);
    vv?.addEventListener('resize', render);
    vv?.addEventListener('scroll', render);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener('resize', render);
      window.removeEventListener('scroll', render);
      vv?.removeEventListener('resize', render);
      vv?.removeEventListener('scroll', render);
      probe.remove();
    };
  }, []);

  if (text == null) return null;
  return (
    <div
      style={{
        position: 'fixed',
        top: 'env(safe-area-inset-top)',
        left: 0,
        right: 0,
        zIndex: 99999,
        background: 'rgba(0,0,0,0.82)',
        color: '#34d399',
        font: '10px/1.45 ui-monospace, monospace',
        padding: '3px 6px',
        whiteSpace: 'pre-wrap',
        pointerEvents: 'none',
      }}
    >
      {text}
    </div>
  );
}
