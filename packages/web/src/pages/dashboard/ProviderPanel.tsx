import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { ProviderIcon } from '@/components/provider-icon';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Progress } from '@/components/ui/progress';
import type { ProviderQuotas } from '@/hooks/useProviderQuotas';
import { PROVIDER_LABEL } from '@/lib/format';
import { formatDateTime, formatNumber } from '@/lib/stats';
import type { ProviderId, ProviderQuota, ProviderStatus } from '@/lib/types';
import { AnimatedBotIcon } from './animated-icons';

interface ProviderPanelProps {
  providers: ProviderStatus[];
  quotas: ProviderQuotas;
  defaultProvider?: ProviderId | undefined;
  offline?: boolean;
}

/**
 * The CLIs the whole app runs on, and how much of the subscription is left.
 *
 * The quota windows come from `GET /api/providers/:id/usage`, which is the
 * only place they exist - the socket has no quota event outside a running
 * turn. A provider that reports none simply shows its status and nothing
 * else, rather than an empty bar that would read as "zero used".
 *
 * Which of them a new turn takes unless the composer says otherwise is the
 * first thing anyone wants to know here, so the preset one is marked. The
 * setting itself stays where it is changed, under Settings.
 */
export function ProviderPanel({
  providers,
  quotas,
  defaultProvider,
  offline = false,
}: ProviderPanelProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Provider</CardTitle>
        <CardDescription>
          Rookery signs in through existing CLI sessions on this computer.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {providers.length === 0 ? (
          <NoProviderStatus offline={offline} />
        ) : (
          <ItemGroup className="gap-2">
            {providers.map((status) => (
              <ProviderRow
                key={status.id}
                status={status}
                quota={quotas[status.id]}
                isDefault={status.id === defaultProvider}
              />
            ))}
          </ItemGroup>
        )}
      </CardContent>
    </Card>
  );
}

function NoProviderStatus({ offline }: { offline: boolean }) {
  if (offline) return <ServerOffline size="sm" />;
  return (
    <EmptyState
      icon={AnimatedBotIcon}
      title="No status data yet"
      description="The server has not reported which CLIs it found yet."
      variant="plain"
      size="sm"
    />
  );
}

interface ProviderRowProps {
  status: ProviderStatus;
  quota: ProviderQuota | undefined;
  isDefault: boolean;
}

function ProviderRow({ status, quota, isDefault }: ProviderRowProps) {
  const detail = [status.version, status.detail].filter(Boolean).join(' · ');
  return (
    <Item variant="outline" size="sm" className="flex-wrap">
      <ItemMedia variant="icon">
        <ProviderIcon provider={status.id} label={status.displayName} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{PROVIDER_LABEL[status.id] ?? status.displayName}</ItemTitle>
        <ItemDescription>{detail || status.binary}</ItemDescription>
      </ItemContent>
      <ItemActions>
        {isDefault ? <Badge variant="outline">Default</Badge> : null}
        {status.usageBlocked ? (
          <Badge variant="outline">
            {status.usageBlocked.until
              ? 'Avoided until ' + formatDateTime(status.usageBlocked.until)
              : 'Avoided'}
          </Badge>
        ) : null}
        <ProviderStateBadge status={status} />
      </ItemActions>
      {quota && quota.windows.length > 0 ? <QuotaWindows quota={quota} /> : null}
    </Item>
  );
}

function ProviderStateBadge({ status }: { status: ProviderStatus }) {
  if (!status.available) return <Badge variant="destructive">Not found</Badge>;
  if (!status.authenticated) return <Badge variant="secondary">Not signed in</Badge>;
  return <Badge>Ready</Badge>;
}

function QuotaWindows({ quota }: { quota: ProviderQuota }) {
  return (
    <ItemFooter className="mt-1 flex-col items-stretch gap-2 border-t pt-3">
      {quota.plan ? <div className="text-xs text-muted-foreground">{quota.plan}</div> : null}
      {quota.windows.map((quotaWindow) => (
        <div key={quotaWindow.kind} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="text-muted-foreground">{quotaWindow.label}</span>
            <span className="tabular-nums">
              {formatNumber(Math.round(quotaWindow.percent))} % used
            </span>
          </div>
          <Progress value={Math.min(100, Math.max(0, quotaWindow.percent))} />
          {quotaWindow.resetsAt ? (
            <div className="text-xs text-muted-foreground">
              Reset on {formatDateTime(quotaWindow.resetsAt)}
            </div>
          ) : null}
        </div>
      ))}
    </ItemFooter>
  );
}
