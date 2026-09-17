import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

/**
 * Markdown for text that is not part of a conversation.
 *
 * The thread's own `MarkdownText` reads its content from assistant-ui's
 * message-part context, so it cannot render a plain string. An assignment's
 * result is exactly that: a finished document, shown on a page. Same parser,
 * same GitHub flavour, styling kept close to the thread's.
 *
 * Previews use the same renderer, never a second component: `preview` swaps
 * the typography for the compact preset below, `clampRem` limits the height
 * of the *rendered* result. Cutting the text before it is parsed is what
 * turns a card into one long code block - a fence opened in the kept half
 * never closes.
 */

/**
 * The compact preset: a heading inside a card is a bold line, not a
 * headline, and three lines of text have no room for `my-3` between their
 * blocks. Heading sizes are `1em` rather than a fixed step so the preset
 * follows whatever size the caller sets on the container.
 */
const PREVIEW_CLASS = [
  '[&_h1]:mt-2 [&_h1]:mb-1 [&_h1]:text-[1em]',
  '[&_h2]:mt-2 [&_h2]:mb-1 [&_h2]:text-[1em]',
  '[&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:text-[1em]',
  '[&_h1:first-child]:mt-0 [&_h2:first-child]:mt-0 [&_h3:first-child]:mt-0',
  '[&_p]:my-1.5',
  '[&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:mt-0.5',
  '[&_blockquote]:my-1.5 [&_blockquote]:ps-2',
  '[&_pre]:my-1.5 [&_pre]:max-h-24 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:p-2 [&_pre]:text-[0.85em]',
  '[&_hr]:my-2',
  '[&_table]:my-1.5',
].join(' ');

export interface ResultMarkdownProps {
  text: string;
  className?: string;
  /** Compact typography for a card, a row or a drawer subtitle. */
  preview?: boolean;
  /** Height limit in rem for the rendered block, with a fade once it bites. */
  clampRem?: number;
}

export function ResultMarkdown({ text, className, preview, clampRem }: ResultMarkdownProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [clamped, setClamped] = useState(false);

  /* The fade only belongs there when something is actually cut off: a short
     text under a generous limit must not look like it continues. */
  useEffect(() => {
    if (clampRem === undefined) {
      setClamped(false);
      return;
    }
    const node = ref.current;
    if (!node) return;
    const measure = (): void => setClamped(node.scrollHeight - node.clientHeight > 2);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [clampRem, text]);

  const fade = 'linear-gradient(to bottom, #000 60%, transparent 100%)';

  return (
    <div
      ref={ref}
      style={{
        ...(clampRem !== undefined ? { maxHeight: clampRem + 'rem', overflow: 'hidden' } : {}),
        ...(clamped ? { maskImage: fade, WebkitMaskImage: fade } : {}),
      }}
      className={cn(
        'text-sm leading-relaxed break-words',
        '[&_h1]:mt-5 [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-semibold',
        '[&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold',
        '[&_h3]:mt-4 [&_h3]:mb-1.5 [&_h3]:text-base [&_h3]:font-semibold',
        '[&_p]:my-3 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
        '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
        '[&_ul]:my-3 [&_ul]:ms-5 [&_ul]:list-disc [&_ol]:my-3 [&_ol]:ms-5 [&_ol]:list-decimal',
        '[&_li]:mt-1',
        '[&_blockquote]:my-3 [&_blockquote]:border-s-2 [&_blockquote]:border-muted-foreground/30 [&_blockquote]:ps-4 [&_blockquote]:text-muted-foreground',
        '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]',
        '[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:bg-muted [&_pre]:p-4',
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
        '[&_hr]:my-4 [&_hr]:border-border',
        '[&_table]:my-3 [&_table]:w-full [&_table]:text-left',
        '[&_th]:border-b [&_th]:px-2 [&_th]:py-1 [&_th]:font-medium',
        '[&_td]:border-b [&_td]:px-2 [&_td]:py-1',
        preview && PREVIEW_CLASS,
        className,
      )}
    >
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
}
