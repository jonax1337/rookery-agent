import { useState } from 'react';

import { BadgeAlertIcon } from '@/components/icons';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { EmptyState } from '@/components/common/empty-state';
import { ResultCard } from '@/components/common/result-card';
import { RunTerminal } from '@/components/common/run-terminal';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { AgentReview, Assignment, AssignmentStatus } from '@/lib/types';

import { AssignmentReviewCard } from './assignment-review-card';
import { isOpenStatus } from './assignment-row';
import { DelegatedRunsTable } from './delegated-runs-table';
import { SendEmptyIcon } from './send-empty-icon';

type TabValue = 'result' | 'error' | 'delegated';

interface AssignmentDetailTabsProps {
  assignmentId: string;
  status: AssignmentStatus;
  result: string;
  error: string | undefined;
  /** The runs this one handed on. */
  delegated: Assignment[];
  reviews: AgentReview[];
  onReviewSaved: (review: AgentReview) => void;
  onCancelRun: (id: string) => void;
}

/**
 * Result, error and sub-assignments behind tabs instead of three cards
 * stacked down the page. Mount it with `key={assignmentId}`: the selected tab
 * belongs to one run, and an "Error" tab selected on a failed run must not
 * follow the reader to a child run that has none.
 */
export function AssignmentDetailTabs({
  assignmentId,
  status,
  result,
  error,
  delegated,
  reviews,
  onReviewSaved,
  onCancelRun,
}: AssignmentDetailTabsProps) {
  const [tab, setTab] = useState<TabValue>('result');
  const open = isOpenStatus(status);

  return (
    <Fade delay={200}>
      <Tabs value={tab} onValueChange={(value) => setTab(value as TabValue)}>
        <TabsList>
          <TabsTrigger value="result">Result</TabsTrigger>
          {error ? (
            <TabsTrigger value="error">
              Error
              <Badge variant="destructive">1</Badge>
            </TabsTrigger>
          ) : null}
          <TabsTrigger value="delegated">
            Delegated
            {delegated.length > 0 ? (
              <Badge variant="secondary" className="tabular-nums">
                {delegated.length}
              </Badge>
            ) : null}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="result" className="mt-4 flex flex-col gap-4">
          {/* The run as it happens, above the result it is heading for - and
              past its end too, because the journal it reads outlives the run:
              the transcript stays where the buffer used to vanish. */}
          <RunTerminal assignmentId={assignmentId} status={status} />
          <ResultOrEmpty result={result} open={open} />
          {open ? null : (
            <AssignmentReviewCard
              assignmentId={assignmentId}
              review={reviews.find((entry) => entry.source === 'user')}
              onSaved={onReviewSaved}
            />
          )}
        </TabsContent>

        {error ? (
          <TabsContent value="error" className="mt-4">
            <Alert variant="destructive">
              <BadgeAlertIcon />
              <AlertTitle>The run failed</AlertTitle>
              <AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription>
            </Alert>
          </TabsContent>
        ) : null}

        <TabsContent value="delegated" className="mt-4">
          <DelegatedRunsTable runs={delegated} onCancelRun={onCancelRun} />
        </TabsContent>
      </Tabs>
    </Fade>
  );
}

function ResultOrEmpty({ result, open }: { result: string; open: boolean }) {
  if (result) {
    return (
      <ResultCard text={result} description="What the agent returned at the end of the run." />
    );
  }

  return (
    <EmptyState
      icon={SendEmptyIcon}
      title="No result yet"
      description={
        open
          ? 'The assignment is still running. Its report appears here when the agent finishes.'
          : 'This assignment did not leave a response.'
      }
      variant="outline"
      size="sm"
    />
  );
}
