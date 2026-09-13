import { fromMarkdown } from 'mdast-util-from-markdown';

type Node = ReturnType<typeof fromMarkdown>['children'][number];
type TextNode = { type: string; value?: string; children?: TextNode[] };
const textOf = (node: TextNode): string => node.value ?? node.children?.map(textOf).join('') ?? '';

/** Map only an unambiguous, trailing sources list; keep all other Markdown intact. */
// ponytail: explicit link lists only; use provider source metadata if formats expand.
export function splitMessageSources(markdown: string) {
  const sources: { type: 'source'; sourceType: 'url'; id: string; url: string; title: string }[] = [];
  const unchanged = { text: markdown, sources };
  if (!/\b(sources|quellen|references)\b/i.test(markdown)) return unchanged;

  const nodes = fromMarkdown(markdown).children;
  const headingIndex = nodes.findLastIndex((node) =>
    (node.type === 'heading' || node.type === 'paragraph') &&
    /^(sources|quellen|references):?$/i.test(textOf(node).trim()),
  );
  if (headingIndex < 0) return unchanged;
  const tail = nodes.slice(headingIndex + 1).filter((node) => node.type !== 'definition');
  const list = tail[0];
  if (tail.length !== 1 || list?.type !== 'list') return unchanged;

  const definitions = new Map(nodes.filter((node) => node.type === 'definition').map((node) => [node.identifier, node]));
  const found = new Map<string, (typeof sources)[number]>();
  for (const item of list.children) {
    const paragraph = item.children[0];
    if (item.children.length !== 1 || paragraph?.type !== 'paragraph' || paragraph.children.length !== 1) return unchanged;
    const link = paragraph.children[0]!;
    const target = link.type === 'linkReference' ? definitions.get(link.identifier) : link;
    const rawUrl = target && 'url' in target ? target.url : link.type === 'text' ? link.value : '';
    let url: URL;
    try { url = new URL(rawUrl); } catch { return unchanged; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return unchanged;
    const title = textOf(link).trim() || url.hostname;
    found.set(url.href, { type: 'source', sourceType: 'url', id: url.href, url: url.href, title });
  }
  if (!found.size) return unchanged;

  // Remove only the heading and list. Reference definitions may still be used in the answer.
  const removed: Node[] = [nodes[headingIndex]!, list];
  let text = markdown;
  for (const node of removed.reverse()) {
    text = text.slice(0, node.position!.start.offset) + text.slice(node.position!.end.offset);
  }
  return { text: text.trimEnd(), sources: [...found.values()] };
}
