import { ResultMarkdown } from '@/components/result-markdown';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** The predecessor's condensed working knowledge, shown on the agent that replaced it. */
export function HandoverCard({
  text,
  predecessorName,
}: {
  text: string;
  predecessorName: string | undefined;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Handover from {predecessorName}</CardTitle>
        <CardDescription>Condensed working knowledge, carried over on replacement.</CardDescription>
      </CardHeader>
      <CardContent>
        <ResultMarkdown text={text} />
      </CardContent>
    </Card>
  );
}
