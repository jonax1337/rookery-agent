import { CheckIcon, CopyIcon } from 'lucide-react';

import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { ResultMarkdown } from '@/components/result-markdown';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

/**
 * What a run produced, with the one thing people do with it: take it away.
 *
 * The task page and the assignment page both end in this card and differed
 * only in the sentence under the title, so that sentence is the prop. Markdown
 * because the runner writes markdown - a `<pre>` would lose its headings.
 */
export function ResultCard({
  text,
  description,
  title = 'Result',
}: {
  text: string;
  /** One line: where this text came from. */
  description: string;
  title?: string;
}) {
  const { isCopied, copyToClipboard } = useCopyToClipboard();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={() => copyToClipboard(text)}>
            {isCopied ? <CheckIcon /> : <CopyIcon />}
            {isCopied ? 'Copied' : 'Copy'}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <ResultMarkdown text={text} />
      </CardContent>
    </Card>
  );
}
