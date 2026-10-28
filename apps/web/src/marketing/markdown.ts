/**
 * The marketing pages are written in a small, strict subset of Markdown so
 * that one source gives both the HTML page and its `.md` twin for AI agents
 * (`/llms.txt`). The subset: `## ` / `### ` headings, paragraphs, `- ` and
 * `1. ` lists, `> ` callouts, pipe tables with a header row, and inline
 * `**bold**`, `` `code` `` and `[text](/path)` links. The content is ours, never user
 * input; anything outside the subset is a mistake and throws at render time
 * so it cannot ship looking broken.
 */
export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

export type Block =
  | { kind: 'h2'; text: string; id: string }
  | { kind: 'h3'; text: string; id: string }
  | { kind: 'p'; inline: Inline[] }
  | { kind: 'ul' | 'ol'; items: Inline[][] }
  | { kind: 'callout'; inline: Inline[] }
  | { kind: 'table'; head: Inline[][]; rows: Inline[][][] };

const INLINE = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`/g;

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const match of source.matchAll(INLINE)) {
    if (match.index > last) out.push({ kind: 'text', text: source.slice(last, match.index) });
    if (match[1] !== undefined) out.push({ kind: 'strong', text: match[1] });
    else if (match[4] !== undefined) out.push({ kind: 'code', text: match[4] });
    else out.push({ kind: 'link', text: match[2], href: match[3] });
    last = match.index + match[0].length;
  }
  if (last < source.length) out.push({ kind: 'text', text: source.slice(last) });
  return out;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  const paragraphs = source.trim().split(/\n\s*\n/);
  for (const raw of paragraphs) {
    const lines = raw.split('\n').map((line) => line.trimEnd());
    const first = lines[0];
    if (first.startsWith('## ') || first.startsWith('### ')) {
      if (lines.length > 1) throw new Error(`A heading must stand alone: "${first}"`);
      const level = first.startsWith('### ') ? 'h3' : 'h2';
      const text = first.replace(/^#{2,3} /, '');
      blocks.push({ kind: level, text, id: slugify(text) });
    } else if (first.startsWith('#')) {
      throw new Error(`Only ## and ### headings are allowed in page bodies: "${first}"`);
    } else if (lines.every((line) => line.startsWith('- '))) {
      blocks.push({ kind: 'ul', items: lines.map((line) => parseInline(line.slice(2))) });
    } else if (lines.every((line) => /^\d+\. /.test(line))) {
      blocks.push({ kind: 'ol', items: lines.map((line) => parseInline(line.replace(/^\d+\. /, ''))) });
    } else if (lines.every((line) => line.startsWith('> '))) {
      blocks.push({ kind: 'callout', inline: parseInline(lines.map((line) => line.slice(2)).join(' ')) });
    } else if (lines.every((line) => line.startsWith('|'))) {
      if (lines.length < 3 || !/^\|[\s|:-]+\|$/.test(lines[1])) throw new Error(`A table needs a header and a separator row: "${first}"`);
      blocks.push({
        kind: 'table',
        head: tableCells(lines[0]).map(parseInline),
        rows: lines.slice(2).map((line) => tableCells(line).map(parseInline)),
      });
    } else if (lines.some((line) => /^(- |\d+\. |> |\|)/.test(line))) {
      throw new Error(`Mixed block (separate lists, tables and quotes from text with a blank line): "${first}"`);
    } else {
      blocks.push({ kind: 'p', inline: parseInline(lines.join(' ')) });
    }
  }
  return blocks;
}

/** The Markdown with every site-relative link made absolute, for agents reading it out of context. */
export function absolutiseLinks(source: string, origin: string): string {
  return source.replace(/\]\((\/[^)\s]*)\)/g, (_, path: string) => `](${origin}${path})`);
}

/** Plain text of a Markdown snippet (JSON-LD answers, meta descriptions). */
export function plainText(source: string): string {
  return source
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}
