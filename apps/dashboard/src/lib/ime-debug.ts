// IME diagnostics — an opt-in probe for the "typing k leaves a raw English k /
// the field gets stuck in English" class of bug (中文输入法被打断).
//
// The failure has two candidate layers and the probe exists to tell them apart
// with evidence instead of guesswork:
//   · page JS eating the keystroke — some handler calling preventDefault() on
//     an unmodified keydown kills composition STARTUP (the first key of a
//     pinyin sequence lands as literal English);
//   · the browser/IME layer itself — macOS Chrome (PWA windows especially) has
//     a long-standing failure mode where a re-focused window doesn't re-attach
//     the input context: every key types English until a blur/refocus. No page
//     JS involved, nothing for us to fix, but we can prove it's that.
//
// OFF by default, zero cost (one localStorage read at module init). Enable:
//   localStorage.setItem('hermit:ime-debug', '1')  → reload
// then reproduce, and read the evidence:
//   window.__imeLog()   — the last 300 keyboard/composition/focus events
// A preventDefault() on an unmodified key logs a console.warn WITH A STACK at
// the moment it happens — if the bug is ours, the culprit names itself.

const FLAG = 'hermit:ime-debug';
const MAX = 300;

interface ImeEvent {
  t: string; // hh:mm:ss.mmm
  ev: string;
  key?: string;
  code?: string;
  keyCode?: number;
  composing?: boolean;
  mods?: string;
  target?: string;
  prevented?: boolean;
  data?: string;
}

const ring: ImeEvent[] = [];

function push(e: ImeEvent) {
  ring.push(e);
  if (ring.length > MAX) ring.shift();
}

function stamp(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function tagOf(t: EventTarget | null): string {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return '?';
  return el.tagName + (el.id ? `#${el.id}` : '') + ((el as HTMLInputElement).placeholder ? `[${(el as HTMLInputElement).placeholder.slice(0, 12)}]` : '');
}

export function installImeDebug(): void {
  if (typeof window === 'undefined') return;
  try {
    if (localStorage.getItem(FLAG) !== '1') return;
  } catch {
    return;
  }
  const w = window as unknown as { __imeDebugInstalled?: boolean; __imeLog?: () => ImeEvent[] };
  if (w.__imeDebugInstalled) return;
  w.__imeDebugInstalled = true;

  // Keyboard, at capture phase so we see the event before any handler touches it.
  window.addEventListener(
    'keydown',
    (e) => {
      push({
        t: stamp(),
        ev: 'keydown',
        key: e.key,
        code: e.code,
        keyCode: e.keyCode,
        composing: e.isComposing,
        mods: `${e.metaKey ? '⌘' : ''}${e.ctrlKey ? '^' : ''}${e.altKey ? '⌥' : ''}${e.shiftKey ? '⇧' : ''}`,
        target: tagOf(e.target),
      });
    },
    true,
  );

  for (const ev of ['compositionstart', 'compositionupdate', 'compositionend'] as const) {
    window.addEventListener(
      ev,
      (e) => push({ t: stamp(), ev, data: (e as CompositionEvent).data?.slice(0, 20), target: tagOf(e.target) }),
      true,
    );
  }
  for (const ev of ['focusin', 'focusout'] as const) {
    window.addEventListener(ev, (e) => push({ t: stamp(), ev, target: tagOf(e.target) }), true);
  }

  // The smoking gun, if the bug is ours: preventDefault() on an UNMODIFIED
  // printable keydown during (or starting) composition. Warn with a stack so
  // the caller identifies itself in the console the moment it happens.
  const orig = KeyboardEvent.prototype.preventDefault;
  KeyboardEvent.prototype.preventDefault = function (this: KeyboardEvent) {
    if (this.type === 'keydown') {
      push({ t: stamp(), ev: 'preventDefault', key: this.key, composing: this.isComposing, target: tagOf(this.target) });
      const unmodified = !this.metaKey && !this.ctrlKey && !this.altKey;
      const printable = this.key.length === 1;
      if (unmodified && (printable || this.isComposing || this.keyCode === 229)) {
        console.warn(`[ime-debug] preventDefault on unmodified keydown key=${this.key} composing=${this.isComposing}`, new Error('caller').stack);
      }
    }
    return orig.call(this);
  };

  w.__imeLog = () => {
    console.table(ring);
    return [...ring];
  };
  console.info('[ime-debug] armed — reproduce the bug, then run window.__imeLog(). Disable: localStorage.removeItem("hermit:ime-debug")');
}
