import { NavLink } from 'react-router';

import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { PageBody } from '@/components/blocks/page-body';
import { EmptyState } from '@/components/common/empty-state';
import { Button } from '@/components/ui/button';
import type { ProviderQuotas } from '@/hooks/useProviderQuotas';
import type { ProviderId, ProviderStatus } from '@/lib/types';
import { AnimatedActivityIcon } from './animated-icons';
import { ProviderPanel } from './ProviderPanel';

interface GetStartedProps {
  assistantName: string;
  onNewConversation(): void;
  providers: ProviderStatus[];
  quotas: ProviderQuotas;
  defaultProvider?: ProviderId | undefined;
}

/**
 * The page of a fresh install, where every count is zero.
 *
 * The providers stay visible: the first question on a fresh install is
 * usually whether the CLIs are signed in at all.
 */
export function GetStarted({
  assistantName,
  onNewConversation,
  providers,
  quotas,
  defaultProvider,
}: GetStartedProps) {
  return (
    <PageBody>
      <Fade>
        <div className="px-4 lg:px-6">
          <EmptyState
            icon={AnimatedActivityIcon}
            title="Get started"
            description={
              assistantName +
              ' has nothing to show yet. One conversation, task, or agent is enough to bring this page to life.'
            }
            actionLabel="New conversation"
            onAction={onNewConversation}
            action={
              <>
                <Button variant="outline" asChild>
                  <NavLink to="/tasks/new">Create task</NavLink>
                </Button>
                <Button variant="outline" asChild>
                  <NavLink to="/org/agents/new">Hire agent</NavLink>
                </Button>
              </>
            }
          />
        </div>
      </Fade>
      <Fade delay={50}>
        <div className="px-4 lg:px-6">
          <ProviderPanel providers={providers} quotas={quotas} defaultProvider={defaultProvider} />
        </div>
      </Fade>
    </PageBody>
  );
}
