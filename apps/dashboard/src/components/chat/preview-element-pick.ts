// A preview page is untrusted and cross-origin. Keep the message parsing and
// composer formatting in one small, pure module so the panel never hands raw
// postMessage fields to the draft.

export interface PreviewElementPick {
  selector: string;
  selectorPath?: string;
  tag?: string;
  label?: string;
  text?: string;
}

function field(value: unknown, max: number, collapseWhitespace = false): string | undefined {
  if (typeof value !== 'string' || value.length > max) return undefined;
  const clean = collapseWhitespace ? value.replace(/\s+/g, ' ').trim() : value.trim();
  return clean || undefined;
}

/** Validate the additive `picked` bridge payload, including old bridges. */
export function readPreviewElementPick(raw: Record<string, unknown>): PreviewElementPick | null {
  const selector = field(raw.selector, 1_200);
  if (!selector) return null;

  const rawTag = field(raw.tag, 64)?.toLowerCase();
  const tag = rawTag && /^[a-z][a-z0-9:-]*$/.test(rawTag) ? rawTag : undefined;
  const selectorPath = field(raw.selectorPath, 4_000);
  const label = field(raw.label, 160, true);
  const text = field(raw.text, 240, true);

  return {
    selector,
    ...(selectorPath ? { selectorPath } : {}),
    ...(tag ? { tag } : {}),
    ...(label ? { label } : {}),
    ...(text ? { text } : {}),
  };
}

/** Markdown inline code with a fence longer than any run in the value. */
function code(value: string): string {
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${value}${pad}${fence}`;
}

/**
 * Keep the concise selector first so an in-progress sentence still reads
 * naturally, then add enough DOM and visible context for the agent to find the
 * intended element without guessing from a bare `#id` or utility class.
 */
export function formatPreviewElementPick(pick: PreviewElementPick): string {
  const details: string[] = [];
  if (pick.tag) details.push(`标签 ${code(pick.tag)}`);
  if (pick.selectorPath && pick.selectorPath !== pick.selector) {
    details.push(`完整路径 ${code(pick.selectorPath)}`);
  }
  if (pick.label) details.push(`名称 ${JSON.stringify(pick.label)}`);
  if (pick.text && pick.text !== pick.label) details.push(`文本 ${JSON.stringify(pick.text)}`);

  const selector = code(pick.selector);
  return details.length ? `${selector}（${details.join('；')}）` : selector;
}
