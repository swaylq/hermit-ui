'use client';

import { isValidElement, useCallback, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
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
// language label in the top-right corner; tables / lists / inline code follow
// Tailwind defaults.

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
        className="!my-0 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 text-zinc-100 px-3 py-2.5 text-[12px] leading-relaxed"
      >
        {children}
      </pre>
    </div>
  );
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose prose-sm max-w-none leading-relaxed [&_p]:my-1 [&_p]:whitespace-pre-wrap [&_code]:font-mono [&_code]:text-[12px] [&_a]:underline [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0 [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-medium [&_h1]:mt-2 [&_h2]:mt-2 [&_h3]:mt-2 [&_h1]:mb-1 [&_h2]:mb-1 [&_h3]:mb-1 [&_table]:my-2 [&_table]:text-xs [&_th]:px-2 [&_th]:py-0.5 [&_td]:px-2 [&_td]:py-0.5 [&_th]:border [&_td]:border [&_blockquote]:border-l-2 [&_blockquote]:pl-2 [&_blockquote]:opacity-80">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCjkFriendly]}
        rehypePlugins={[[rehypeHighlight, { languages, detect: true, ignoreMissing: true }]]}
        components={{
          a({ href, children: linkChildren, ...rest }) {
            return (
              <a href={href} target="_blank" rel="noreferrer" {...rest}>
                {linkChildren}
              </a>
            );
          },
          pre({ children: preChildren, ...rest }) {
            const lang = extractLanguage(preChildren);
            return <CodeBlock lang={lang} preProps={rest}>{preChildren}</CodeBlock>;
          },
          code(props) {
            const { className, children: codeChildren, ...rest } = props as {
              className?: string;
              children?: ReactNode;
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
              <code className="rounded border border-border bg-muted px-1 py-px text-[11px]" {...rest}>
                {codeChildren}
              </code>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
