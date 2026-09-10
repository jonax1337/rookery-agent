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
 */
export function ResultMarkdown({ text, className }: { text: string; className?: string }) {
  return (
    <div
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
        className,
      )}
    >
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
}
