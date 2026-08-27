// One clipboard write for the whole app, with the legacy path kept as a fallback.
//
// `navigator.clipboard` is only defined in a secure context, so it is simply
// MISSING whenever the dashboard is opened over plain http on the LAN — and the
// old inline `try { await navigator.clipboard.writeText(t) } catch {}` swallowed
// that into a button that looked like it worked and copied nothing. It can also
// reject with NotAllowedError when Safari decides the user gesture has expired.
// Both cases fall through to the execCommand path, which still works in every
// current browser, and the caller gets a boolean so it can show the failure.
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    // Off-screen but still focusable. `position: fixed` + opacity 0 avoids the
    // page scrolling to the element, which is what a naive -9999px left does on
    // iOS; the explicit selection range is what iOS Safari needs (plain
    // .select() is a no-op on a readonly textarea there).
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
