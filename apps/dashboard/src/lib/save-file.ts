// Saving a file from the dashboard WITHOUT ever navigating the PWA away, plus the
// touch-vs-desktop share/download gate that goes with it. Extracted from the chat
// page so the image lightbox reuses the exact same (subtle) gating — see the
// hermit-ui-desktop-download-share-gate lesson for why the gate is what it is.

export function isTouchPrimary(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
}

// Save `url` to the user's device as `name`.
//
// Touch / iOS-standalone ONLY: there `<a download>` is ignored and a plain link
// navigates the PWA away with no way back, so the share sheet is the only safe path
// — and we stay on it even on cancel (no link fallthrough = no trap). DESKTOP also
// reports canShare({files})=true (macOS Safari/Chrome), but routing a download into
// the OS share sheet means a normal click never downloads, and share() after the
// awaited fetch can silently throw on lost user-activation (the "点击不会下载" bug).
// So gate share to touch; desktop falls through to the reliable object-URL download.
export async function saveFile(url: string, name: string, mimeType?: string | null): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const file = new File([blob], name || 'file', { type: mimeType || blob.type || 'application/octet-stream' });
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  if (isTouchPrimary() && nav?.canShare?.({ files: [file] })) {
    try { await nav.share({ files: [file] }); } catch { /* cancelled / unsupported */ }
    return;
  }
  const obj = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = obj;
  a.download = name || 'file';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(obj), 4000);
}
