import { escapeHtml } from '@rookery/core';

/**
 * Markdown as Telegram renders it.
 *
 * The models write Markdown. Telegram does not read Markdown - it reads its
 * own small HTML dialect - so an answer used to arrive with `**bold**` and
 * `## Heading` standing in it as literal characters. This turns the one into
 * the other.
 *
 * Two rules shape everything here.
 *
 * **Only what Telegram accepts.** Its parser takes a closed list of tags - b,
 * i, u, s, a, code, pre, blockquote, tg-spoiler - and answers a 400 for
 * anything else, which does not degrade to plain text but loses the whole
 * message. So headings become bold lines, bullets become `•`, rules become a
 * dash, and nothing invents a tag.
 *
 * **Never produce an unbalanced tag.** The answer is also written *while* it
 * streams, so this runs on text that stops mid-sentence, mid-word, and
 * mid-`**`. Every rule here matches a complete pair or does nothing at all:
 * a half-typed marker stays a literal asterisk for one more second and then
 * becomes bold when its partner arrives. An unclosed `<b>` would instead
 * make Telegram refuse the edit, and the message would appear to freeze.
 */

/** Language tags worth putting on a code block; anything odd is dropped. */
const LANGUAGE = /^[A-Za-z0-9+#._-]{1,24}$/;

/** Schemes a link may use. Everything else stays literal text. */
const SAFE_SCHEME = /^(https?:\/\/|tg:\/\/|mailto:)/i;

/**
 * A link target, or nothing. The text arrives already HTML-escaped, which is
 * what an attribute value needs; what is checked here is the scheme, because
 * `javascript:` in an answer must not become a tappable link on a phone.
 */
function safeUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (!SAFE_SCHEME.test(trimmed)) return undefined;
  // A quote that survived escaping would end the attribute early; whitespace
  // and angle brackets have no business in a href either.
  if (/["'\s<>]/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Inline markers on one stretch of text that is known to hold no code span.
 * The text is already escaped, so the markers are all that is left to find.
 */
function marks(escaped: string): string {
  let out = escaped;

  // Links first: their label is styled text and their target must not be.
  out = out.replace(/\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/g, (all, label: string, url: string) => {
    const href = safeUrl(url);
    return href ? `<a href="${href}">${label}</a>` : all;
  });

  // Bold before italic, and the three-marker form before both, or `***x***`
  // would be read as bold plus a stray asterisk.
  out = out.replace(/\*\*\*(?![\s*])([^*]+?)\*\*\*/g, '<b><i>$1</i></b>');
  out = out.replace(/\*\*(?![\s*])([^*]+?)\*\*/g, '<b>$1</b>');
  out = out.replace(/__(?![\s_])([^_]+?)__/g, '<b>$1</b>');

  // Single markers need a boundary on both sides. Without it every
  // snake_case identifier and every multiplication turns into italics.
  out = out.replace(/(^|[\s(["'])\*(?![\s*])([^*\n]+?)\*(?=$|[\s).,!?:;\]"'])/g, '$1<i>$2</i>');
  out = out.replace(/(^|[\s(["'])_(?![\s_])([^_\n]+?)_(?=$|[\s).,!?:;\]"'])/g, '$1<i>$2</i>');

  out = out.replace(/~~(?!\s)([^~\n]+?)~~/g, '<s>$1</s>');
  out = out.replace(/\|\|(?!\s)([^|\n]+?)\|\|/g, '<span class="tg-spoiler">$1</span>');
  return out;
}

/**
 * One line of ordinary text, escaped and marked up. Code spans are taken out
 * first: `**` inside backticks is a pair of asterisks the author meant to
 * show, not an instruction to embolden anything.
 */
function inline(text: string): string {
  const parts: string[] = [];
  const pattern = /`([^`\n]+)`/g;
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    parts.push(marks(escapeHtml(text.slice(last, match.index))));
    parts.push(`<code>${escapeHtml(match[1] as string)}</code>`);
    last = pattern.lastIndex;
  }
  parts.push(marks(escapeHtml(text.slice(last))));
  return parts.join('');
}

function codeBlock(lines: string[], language: string): string {
  const body = escapeHtml(lines.join('\n'));
  return LANGUAGE.test(language)
    ? `<pre><code class="language-${language}">${body}</code></pre>`
    : `<pre>${body}</pre>`;
}

/**
 * Block-level Markdown that Telegram has no equivalent for, translated into
 * what it does have: weight, a bullet character, a dash.
 */
function block(line: string): string {
  // A horizontal rule: three or more of the same marker, alone on the line.
  if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) return '—';

  const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
  if (heading) return `<b>${inline(heading[2] as string)}</b>`;

  // A task list is a bullet with a state, and the box is the point of it.
  const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
  if (task) return `${task[1]}${(task[2] as string).toLowerCase() === 'x' ? '☑' : '☐'} ${inline(task[3] as string)}`;

  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return `${bullet[1]}• ${inline(bullet[2] as string)}`;

  // Numbered lists keep their numbers: Telegram has no list of its own, and
  // the number is the information.
  const numbered = /^(\s*)(\d{1,3})[.)]\s+(.*)$/.exec(line);
  if (numbered) return `${numbered[1]}${numbered[2]}. ${inline(numbered[3] as string)}`;

  return inline(line);
}

/**
 * Markdown to the HTML subset Telegram renders.
 *
 * Safe to call on a partial document: an unfinished fence closes itself, an
 * unfinished marker stays literal, and the result is always something
 * Telegram's parser accepts.
 */
export function toTelegramHtml(markdown: string): string {
  if (typeof markdown !== 'string') return '';
  const out: string[] = [];
  let code: string[] | undefined;
  let language = '';
  let quote: string[] | undefined;

  const flushQuote = (): void => {
    if (!quote) return;
    out.push(`<blockquote>${quote.join('\n')}</blockquote>`);
    quote = undefined;
  };

  for (const line of markdown.split('\n')) {
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      if (code) {
        out.push(codeBlock(code, language));
        code = undefined;
        language = '';
      } else {
        flushQuote();
        code = [];
        language = (fence[1] as string).trim().slice(0, 24);
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }

    const quoted = /^\s*>\s?(.*)$/.exec(line);
    if (quoted) {
      (quote ??= []).push(inline(quoted[1] as string));
      continue;
    }
    flushQuote();
    out.push(block(line));
  }

  // A block still open at the end is closed here rather than left dangling:
  // while an answer streams, the end of the text is always the middle of it.
  if (code) out.push(codeBlock(code, language));
  flushQuote();
  return out.join('\n');
}
