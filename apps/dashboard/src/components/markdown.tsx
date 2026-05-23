'use client';

import { isValidElement, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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

export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose prose-sm max-w-none leading-relaxed [&_p]:my-1 [&_p]:whitespace-pre-wrap [&_code]:font-mono [&_code]:text-[12px] [&_a]:underline [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0 [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-medium [&_h1]:mt-2 [&_h2]:mt-2 [&_h3]:mt-2 [&_h1]:mb-1 [&_h2]:mb-1 [&_h3]:mb-1 [&_table]:my-2 [&_table]:text-xs [&_th]:px-2 [&_th]:py-0.5 [&_td]:px-2 [&_td]:py-0.5 [&_th]:border [&_td]:border [&_blockquote]:border-l-2 [&_blockquote]:pl-2 [&_blockquote]:opacity-80">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
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
            return (
              <div className="relative my-2 group/code">
                {lang && (
                  <span className="absolute right-2 top-1.5 z-10 select-none rounded px-1 py-0.5 text-[9px] font-mono uppercase tracking-[0.1em] text-zinc-500 opacity-60 group-hover/code:opacity-100 transition-opacity">
                    {lang}
                  </span>
                )}
                <pre
                  {...rest}
                  className="!my-0 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 text-zinc-100 px-3 py-2.5 text-[12px] leading-relaxed"
                >
                  {preChildren}
                </pre>
              </div>
            );
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
