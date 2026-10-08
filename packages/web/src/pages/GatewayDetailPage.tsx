import { forwardRef } from 'react';
import { NavLink, useParams } from 'react-router';

import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { PageBody } from '@/components/blocks/page-body';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { FormFieldsSkeleton } from '@/components/forms/form-kit';
import { RadioTowerIcon } from '@/components/icons';
import { usePageMeta } from '@/components/shell/page-meta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useGateway } from '@/hooks/useGateways';
import { useGatewayDraft, type GatewayDraft } from '@/hooks/useGatewayDraft';
import { useGatewayTestMessage } from '@/hooks/useGatewayTestMessage';
import { gatewayStateLook } from '@/lib/gateways';
import type { GatewayStatus } from '@/lib/types';
import { useConfig } from '@/providers/rookery-provider';
import { GatewayHeaderActions } from './gateway/GatewayHeaderActions';
import { GatewaySettingsForm } from './gateway/GatewaySettingsForm';
import { GatewayStatusCard } from './gateway/GatewayStatusCard';
import { FADE_STEP_MS } from './settings/fields';

/**
 * The Telegram gateway's own settings.
 *
 * The page mirrors two templates rather than inventing a third: the frame,
 * the status badge and the `MetaList` come from `ToolDetailPage`; the draft,
 * "Save" and the deep-compared dirty flag come straight from `SettingsPage`
 * (see `useGatewayDraft`), because this is the same kind of write.
 *
 * `GatewayId` only ever names `telegram` today, but the route stays
 * `/gateways/:id` so a second gateway needs a new `id` here and nothing else
 * upstream.
 */

const TELEGRAM_ID = 'telegram';

/**
 * The empty-state icon as an animate-ui version. `EmptyState` takes a
 * `IconComponent` and renders it without props, so the animated icon sits in a
 * forwardRef shell that carries its `animateOnView` trigger along.
 */
const EmptyRadioTowerIcon = forwardRef<SVGSVGElement>(function EmptyRadioTowerIcon() {
  return <RadioTowerIcon />;
});

export function GatewayDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { gateway, loading, error, refresh, test } = useGateway(id);
  const { config, save } = useConfig();
  const form = useGatewayDraft(config, save, refresh);
  const { testing, runTest } = useGatewayTestMessage(test);

  usePageMeta(
    {
      breadcrumb: [{ label: 'Gateways', to: '/gateways' }, { label: gateway?.label ?? 'Gateway' }],
      actions: gateway ? (
        <GatewayHeaderActions
          dirty={form.dirty}
          saving={form.saving}
          testing={testing}
          onTest={() => void runTest()}
          onDiscard={form.discard}
        />
      ) : undefined,
    },
    [gateway, form.dirty, form.saving, testing, form.discard, runTest],
  );

  if (id !== TELEGRAM_ID) return <GatewayUnavailable />;
  if (!gateway && loading) return <GatewayLoading />;
  if (!gateway) return <GatewayUnavailable onRetry={error ? () => void refresh() : undefined} />;
  return <GatewayDetail gateway={gateway} form={form} />;
}

function GatewayDetail({ gateway, form }: { gateway: GatewayStatus; form: GatewayDraft }) {
  return (
    <PageBody width="3xl">
      <div className="flex flex-col gap-3">
        <Fade>
          <div className="flex flex-wrap items-center gap-2">
            <GatewayStateBadge gateway={gateway} />
          </div>
        </Fade>
      </div>

      <Fade delay={FADE_STEP_MS}>
        <GatewayStatusCard gateway={gateway} />
      </Fade>

      <Fade delay={FADE_STEP_MS * 2}>
        <GatewaySettingsForm gateway={gateway} form={form} />
      </Fade>

      <Fade delay={FADE_STEP_MS * 3}>
        <p className="text-xs text-muted-foreground">
          View all gateways under{' '}
          <Button
            asChild
            variant="link"
            className="h-auto gap-0 p-0 text-left align-baseline text-xs"
          >
            <NavLink to="/gateways">Gateways</NavLink>
          </Button>
          .
        </p>
      </Fade>
    </PageBody>
  );
}

function GatewayStateBadge({ gateway }: { gateway: GatewayStatus }) {
  const look = gatewayStateLook(gateway);
  return (
    <Badge variant={look.variant} className="gap-1">
      {look.icon ? <look.icon className={look.iconClassName} aria-hidden="true" /> : null}
      {look.label}
    </Badge>
  );
}

function GatewayLoading() {
  return (
    <PageBody width="3xl">
      <Fade>
        <Card>
          <CardHeader>
            <CardTitle>Status</CardTitle>
          </CardHeader>
          <CardContent>
            <FormFieldsSkeleton fields={4} />
          </CardContent>
        </Card>
      </Fade>
    </PageBody>
  );
}

/** The page body when there is no gateway to show; `onRetry` marks the server as unreachable. */
function GatewayUnavailable({ onRetry }: { onRetry?: () => void }) {
  return (
    <PageBody width="3xl">
      <Fade>
        {onRetry ? (
          <ServerOffline onRetry={onRetry} />
        ) : (
          <EmptyState
            icon={EmptyRadioTowerIcon}
            title="Gateway not found"
            description="The entry was removed or the address is incorrect."
            actionLabel="Back to gateways"
            actionTo="/gateways"
          />
        )}
      </Fade>
    </PageBody>
  );
}
