'use client';

import { Component, isValidElement, memo, useCallback, useRef, useState, type ErrorInfo, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Options as ReactMarkdownOptions } from 'react-markdown';
import remarkGfm from 'remark-gfm';
// CJK-friendly emphasis: stock CommonMark won't close `**bold**` when followed
// by a full-width punctuation char (e.g. `**整体风格：**`) — Chinese/Japanese
// punctuation isn't classified as a word boundary by the right-flanking rule,
// so the closing `**` is treated as part of the same emphasis "candidate" and
// the markdown renders as literal asterisks. This plugin patches the rule.
import remarkCjkFriendly from 'remark-cjk-friendly';
import rehypeHighlight from 'rehype-highlight';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

// Tree-shaken language pack. Aliases map common short forms (sh → bash,
// ts → typescript, html → xml) so a fenced ```sh block still highlights.
const languages = {
  bash,
  sh: bash,
  shell: bash,
  zsh: bash,
  css,
  diff,
  patch: diff,
  go,
  golang: go,
  javascript,
  js: javascript,
  jsx: javascript,
  json,
  markdown,
  md: markdown,
  plaintext,
  text: plaintext,
  python,
  py: python,
  rust,
  rs: rust,
  sql,
  typescript,
  ts: typescript,
  tsx: typescript,
  xml,
  html: xml,
  svg: xml,
  yaml,
  yml: yaml,
};

// Build the highlight registry ONCE, not once per bubble.
//
// rehype-highlight does its expensive work in the ATTACHER, not the transform:
// `rehypeHighlight(options)` calls `createLowlight(languages)`, which runs a
// `registerLanguage` for each entry above — and highlight.js's `sql` grammar is
// the single hottest app function in a session-switch CPU profile. react-markdown
// builds a FRESH unified processor on every render (`createProcessor` →
// `.use(rehypePlugins)`, frozen on the first `parse`), so passing the plugin as
// `[rehypeHighlight, opts]` rebuilt all 14 grammars for every markdown bubble:
// 0.61ms of the 0.77ms each bubble cost, i.e. ~80% of the render.
//
// Calling the attacher here instead and handing every processor the same
// transform is safe: the registry is immutable config, and the returned
// transform is a pure `(tree, file)` visitor that keeps no per-document state.
// Verified byte-identical hast output before/after.
//
// (The old inline options also carried `ignoreMissing: true`. That option was
// dropped in rehype-highlight 7 — it appears nowhere in the installed source, so
// it had been doing nothing; it only survived because `PluggableList` is typed
// loosely enough that TS never checked it. v7 already renders an unknown
// language as a plain block, which is what `ignoreMissing` used to ask for.)
const highlightTransform = rehypeHighlight({ languages, detect: false });
function rehypeHighlightShared() {
  return highlightTransform;
}

// Hoisted so the plugin lists aren't reallocated per render either. (remark's
// two plugins must stay attachers — they register micromark extensions into
// per-processor data, so they can't be pre-bound the way the highlighter can.)
const REMARK_PLUGINS = [remarkGfm, remarkCjkFriendly];
const REHYPE_PLUGINS = [rehypeHighlightShared];

// Pull the `language-xxx` token off the first React child of a <pre> block so
// we can render it as a corner badge above the code.
function extractLanguage(children: ReactNode): string | undefined {
  const first = Array.isArray(children) ? children[0] : children;
  if (!isValidElement(first)) return undefined;
  const cls = (first.props as { className?: string }).className;
  const m = cls?.match(/language-([\w+-]+)/);
  return m ? m[1] : undefined;
}

// Lightweight markdown renderer used inside chat bubbles. Inherits the bubble's
// text color (dark on light bubbles, light on dark bubbles) so we don't need
// per-theme styling everywhere. Code blocks get a dim background with
// syntax-highlighted spans (rehype-highlight + highlight.js) and a small
// language label in the top-right corner. Lists carry explicit
// list-disc/list-decimal: Tailwind v4's preflight resets `ol/ul` to
// `list-style: none`, and there's no @tailwindcss/typography plugin here, so
// without these the markers (ordered numbers / bullets) silently vanish.

// Code block with a language pill (top-right) and a hover Copy button. We
// reach into the rendered <pre> via a ref to pull `textContent` instead of
// trying to walk the React children tree — that way we get the actual source
// text without highlight.js's <span> wrappers.
function CodeBlock({
  lang,
  preProps,
  children,
}: {
  lang?: string;
  preProps: Record<string, unknown>;
  children: ReactNode;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    const text = preRef.current?.textContent ?? '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard may be denied — fail silent.
    }
  }, []);
  return (
    <div className="relative my-2 group/code">
      <div className="absolute right-1.5 top-1.5 z-10 flex items-center gap-1.5 opacity-0 group-hover/code:opacity-100 focus-within:opacity-100 transition-opacity">
        {lang && (
          <span className="select-none rounded px-1 py-0.5 text-[9px] font-mono uppercase tracking-[0.1em] text-zinc-500">
            {lang}
          </span>
        )}
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? 'copied' : 'copy code'}
          className="cursor-pointer rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[10px] font-mono text-zinc-300 hover:text-zinc-50 hover:bg-zinc-800 transition-colors"
        >
          {copied ? '✓ copied' : 'copy'}
        </button>
      </div>
      <pre
        ref={preRef}
        {...preProps}
        // A fenced block WITHOUT a language gets no `language-` class, so the code
        // renderer below treats it as INLINE and gives it the `bg-muted` chip
        // style — which is a near-white box in light mode, and its inline display
        // paints one light bar PER wrapped line with the (inherited light) text
        // invisible on top. Neutralize any direct code child back to a bare block
        // so the zinc-950 surface + light text show through. No-op for a
        // language-tagged block (its <code class="hljs …"> has none of these).
        className="!my-0 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 text-zinc-100 px-3 py-2.5 text-[12px] leading-relaxed [&>code]:block [&>code]:border-0 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit"
      >
        {children}
      </pre>
    </div>
  );
}

// React error boundary so a broken plugin or a malformed markdown token can't
// silently truncate a turn. Caught errors land in the console with their stack
// (so a dev can find which plugin blew up); the bubble falls back to the raw
// markdown source rendered as preformatted text. The user sees something
// useful instead of a turn that just stops mid-word.
class MarkdownErrorBoundary extends Component<{ children: ReactNode; raw: string }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError(): { hasError: true } {
    return { hasError: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Markdown] render failed, falling back to raw text:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <pre className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground/85">
          {this.props.raw}
        </pre>
      );
    }
    return this.props.children;
  }
}

// Hoisted out of the render: this object is half of the processor's identity, and
// react-markdown reads it on every render. Nothing in it closes over props, so a
// module constant is the same object every bubble sees — which is what makes the
// render cache below keyable on the source string alone.
const MARKDOWN_COMPONENTS: ReactMarkdownOptions['components'] = {
  a({ href, children: linkChildren, node: _n, ...rest }) {
    return (
      <a href={href} target="_blank" rel="noreferrer" {...rest}>
        {linkChildren}
      </a>
    );
  },
  pre({ children: preChildren, node: _n, ...rest }) {
    const lang = extractLanguage(preChildren);
    return <CodeBlock lang={lang} preProps={rest}>{preChildren}</CodeBlock>;
  },
  code(props) {
    // react-markdown passes a `node` prop (the mdast AST node) to component
    // overrides — useful for plugins, but spreading it onto the underlying
    // HTML element leaks `node="[object Object]"` as a literal attribute.
    // Strip it so the DOM stays clean.
    const { className, children: codeChildren, node: _n, ...rest } = props as {
      className?: string;
      children?: ReactNode;
      node?: unknown;
    };
    const isBlock = /language-/.test(className || '');
    if (isBlock) {
      return (
        <code className={className} {...rest}>
          {codeChildren}
        </code>
      );
    }
    return (
      // Explicit text-foreground (not inherited): in a USER bubble (dark
      // surface, light inherited text) the bg-muted chip is near-white in
      // light mode, so inherited light text vanished. text-foreground is
      // a token — dark in light mode, light in dark mode — so the chip
      // reads on its muted background in every bubble × theme combo.
      <code className="rounded border border-border bg-muted text-foreground px-1 py-px text-[11px] break-words" {...rest}>
        {codeChildren}
      </code>
    );
  },
  table({ children: tableChildren, node: _n, ...rest }) {
    // A wide table scrolls within its own box (per-message horizontal
    // scroll) instead of pushing the whole conversation into a swipe.
    return (
      <div className="max-w-full overflow-x-auto">
        <table {...rest}>{tableChildren}</table>
      </div>
    );
  },
};

// detect:false — only highlight fences with an explicit language tag (```ts /
// ```bash / ```json …). Auto-detection runs the full language pack against EVERY
// untagged block; the chat is full of untagged tool-output fences, so that was a
// real chunk of the first-render long task — and it mis-highlights plain
// logs/output anyway. Tagged blocks still highlight; untagged render as clean
// monospace. (The option lives on the shared transform above — see
// rehypeHighlightShared.)
const MARKDOWN_OPTIONS: ReactMarkdownOptions = {
  remarkPlugins: REMARK_PLUGINS,
  rehypePlugins: REHYPE_PLUGINS,
  components: MARKDOWN_COMPONENTS,
};

// ── Cross-mount render cache ────────────────────────────────────────────────
//
// `memo` below only spans ONE mount: it stops a bubble re-parsing when its parent
// re-renders. But the timeline unmounts and remounts bubbles constantly —
// switching sessions in the sidebar, leaving /chat and coming back, and (past the
// 400-row windowing threshold) simply scrolling a row out of and back into the
// window. Each of those re-ran the whole unified pipeline from scratch: mdast
// parse → remark-gfm/cjk → hast → highlight.js → React elements. In a CPU profile
// of one session switch (60 bubbles, 4× throttle) the markdown chunk is the
// hottest thing in the app by a wide margin — ~38ms of self time against
// react-dom's ~14ms.
//
// Markdown output is a pure function of its source (the options above are module
// constants), so the produced element tree can simply be kept. React elements are
// immutable descriptors and hold no instance state — the same tree can be handed
// to a later mount, or to two mounts at once, and each gets its own fibers. So a
// re-entered session re-uses trees instead of re-parsing them.
//
// Bounded by SOURCE characters rather than entry count: one 40k-char message
// costs far more to hold than eighty 500-char ones, and the source length is the
// only cheap proxy for tree size we have.
//
// The budget is small on purpose. An element tree is FAR heavier than its source
// — measured (harness/md-mem.mjs, node --expose-gc, trees held live across a
// forced GC): ~37 bytes retained per source character for plain prose, ~146 for a
// bubble carrying a GFM table and a highlighted code fence (highlight.js turns one
// fence into hundreds of span elements). 80k characters is therefore ~3 MB of
// ordinary chat and ~11 MB in the pathological all-rich case — the ceiling this
// trade is worth. In bubbles that is roughly one to three screens of history,
// which is what the common wins need: leaving /chat and coming back, and flipping
// between the last couple of sessions.
const RENDER_CACHE = new Map<string, ReactElement>();
const RENDER_CACHE_BUDGET = 80_000;
let cachedChars = 0;
// The most recently *parsed* source, for the streaming rule in renderCached().
let lastParsed: string | null = null;

function renderCached(source: string): ReactElement {
  const hit = RENDER_CACHE.get(source);
  if (hit) {
    // Re-insert so Map iteration order stays least-recently-used first.
    RENDER_CACHE.delete(source);
    RENDER_CACHE.set(source, hit);
    return hit;
  }

  // react-markdown's default export is its SYNCHRONOUS renderer — declared
  // `(options: Options) => ReactElement`, with no hooks (the hook-using variant
  // is the separate `MarkdownHooks` export). Calling it directly is what lets us
  // hold on to the tree it builds; rendering it as `<ReactMarkdown>` would hand
  // the tree to React and throw it away on unmount.
  const tree = ReactMarkdown({ ...MARKDOWN_OPTIONS, children: source });

  // A streaming bubble arrives as a growing sequence of prefixes of one message.
  // Every intermediate prefix is a tree that can never be hit again, so let each
  // growth step replace the step it grew out of — otherwise one long turn would
  // evict the real history that this cache exists to keep.
  if (lastParsed !== null && lastParsed.length < source.length && source.startsWith(lastParsed)) {
    if (RENDER_CACHE.delete(lastParsed)) cachedChars -= lastParsed.length;
  }

  RENDER_CACHE.set(source, tree);
  cachedChars += source.length;
  lastParsed = source;

  // Trim from the least-recently-used end. `k === source` stops us evicting the
  // entry we just built, so a single over-budget message ends up alone in the
  // cache rather than being dropped on the way in.
  for (const k of RENDER_CACHE.keys()) {
    if (cachedChars <= RENDER_CACHE_BUDGET || k === source) break;
    RENDER_CACHE.delete(k);
    cachedChars -= k.length;
  }
  return tree;
}

// Kept as its own component so a parse failure still throws BELOW
// MarkdownErrorBoundary and lands in its raw-text fallback, exactly as when the
// pipeline ran inside <ReactMarkdown>.
function CachedMarkdown({ children }: { children: string }) {
  return renderCached(children);
}

// Memoized on the `children` string: markdown output is a pure function of its
// source, so an unchanged bubble never re-parses (remark) or re-highlights
// (highlight.js) on a parent re-render. This is the single biggest win for
// streaming smoothness — without it, every poll/SSE tick that re-rendered a row
// re-ran the full highlight pipeline for that bubble.
const MarkdownImpl = memo(function MarkdownImpl({ children }: { children: string }) {
  return (
    <MarkdownErrorBoundary raw={children}>
      <div className="prose prose-sm max-w-none break-words [overflow-wrap:anywhere] leading-[1.65] [&_p]:my-1.5 [&_p]:whitespace-pre-wrap [&_code]:font-mono [&_code]:text-[12px] [&_a]:underline [&_a]:underline-offset-2 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_li>p]:my-0 [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-medium [&_h1]:mt-3 [&_h2]:mt-3 [&_h3]:mt-3 [&_h1]:mb-1 [&_h2]:mb-1 [&_h3]:mb-1 [&_table]:my-2 [&_table]:text-xs [&_th]:px-2 [&_th]:py-0.5 [&_td]:px-2 [&_td]:py-0.5 [&_th]:border [&_td]:border [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:my-2 [&_blockquote]:opacity-80 [&_hr]:my-3 [&_hr]:border-border">
        <CachedMarkdown>{children}</CachedMarkdown>
      </div>
    </MarkdownErrorBoundary>
  );
});

export default MarkdownImpl;
