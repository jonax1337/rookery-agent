import { useCallback, useEffect, useState } from 'react';
import { NavLink } from 'react-router';
import { EllipsisVerticalIcon, RefreshCwIcon, Settings2Icon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { api } from '@/lib/api';
import { PROVIDER_LABEL } from '@/lib/format';
import { formatDateTime, formatPercent } from '@/lib/stats';
import type { ProviderQuota, ProviderStatus } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useChatSession, useConfig, useConnection } from '@/providers/rookery-provider';
import { ProviderIcon } from '@/components/provider-icon';
import { AssistantAvatar } from '@/components/shell/assistant-avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Progress } from '@/components/ui/progress';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';

/**
 * The sidebar's footer: who the app is and whether it is reachable.
 *
 * The markup is dashboard-01's `nav-user` - the same `size="lg"` trigger with
 * an avatar, two lines and an ellipsis - but the content is the only account
 * Rookery has: itself. The block's avatar image is gone (it loads a file that
 * does not exist here); in its place the assistant wears the voice orb, which
 * turns violet while it is thinking.
 *
 * The old sidebar showed a green dot and one sentence and nothing else; the
 * menu behind it now holds what used to be scattered - provider quotas, the
 * appearance switch that sat in the header, and the way back online.
 */
export function NavStatus() {
  const { isMobile } = useSidebar();
  const { assistantName, config, providers } = useConfig();
  const { connected, offline, socket, reload } = useConnection();
  const { chat } = useChatSession();
  const { theme, setTheme } = useTheme();

  // Three states, not two: the socket needs a moment after a reload, and
  // "Verbindet ..." is the honest word for it. Only a failed REST call is a
  // real outage.
  const status = connected ? 'online' : offline ? 'offline' : 'connecting';
  const statusLabel =
    status === 'online' ? 'Verbunden' : status === 'offline' ? 'Keine Verbindung' : 'Verbindet …';
  // The menu names the machine rather than describing the state again - the
  // line above it already says "Verbunden". `0.0.0.0` means "every interface",
  // which is not an address anyone can type, so the page's own hostname stands
  // in for it; the port is always the server's own.
  const address =
    config?.port === undefined
      ? null
      : (config.host && config.host !== '0.0.0.0' ? config.host : window.location.hostname) +
        ':' +
        config.port;
  const statusDetail =
    address ??
    (status === 'online'
      ? 'Mit dem Rookery-Server verbunden'
      : status === 'offline'
        ? 'Der Rookery-Server antwortet nicht'
        : 'Verbindung wird aufgebaut');

  const reconnect = useCallback(() => {
    // The socket reconnects on a backoff timer by itself; `connect()` is the
    // "now, please" version of it, and the REST state has to come along.
    socket.connect();
    void reload();
  }, [reload, socket]);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <AssistantAvatar busy={chat.busy} label={assistantName} />
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{assistantName}</span>
                <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                  <StatusDot status={status} />
                  {statusLabel}
                </span>
              </div>
              <EllipsisVerticalIcon className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>

          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? 'bottom' : 'right'}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <AssistantAvatar busy={chat.busy} label={assistantName} />
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{assistantName}</span>
                  <span className="truncate text-xs text-muted-foreground">{statusDetail}</span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />

            {providers.length > 0 && (
              <>
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                    Anbieter
                  </DropdownMenuLabel>
                  {providers.map((provider) => (
                    <ProviderQuotaSub key={provider.id} provider={provider} />
                  ))}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
              </>
            )}

            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Erscheinungsbild
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup value={theme ?? 'system'} onValueChange={setTheme}>
              <DropdownMenuRadioItem value="light">Hell</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">Dunkel</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />

            <DropdownMenuItem asChild>
              <NavLink to="/settings">
                <Settings2Icon />
                Einstellungen
              </NavLink>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={reconnect}>
              <RefreshCwIcon />
              Neu verbinden
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function StatusDot({ status }: { status: 'online' | 'offline' | 'connecting' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'size-1.5 rounded-full',
        status === 'online' && 'bg-primary',
        status === 'offline' && 'bg-destructive',
        status === 'connecting' && 'animate-pulse bg-muted-foreground',
      )}
    />
  );
}

/**
 * One provider's quota windows, fetched the first time its submenu opens.
 *
 * `GET /api/providers/:id/usage` shells out to the provider's CLI, so it is
 * far too expensive to load for a sidebar nobody has opened. Everything shown
 * is what that call returns - no window, no bar.
 */
function ProviderQuotaSub({ provider }: { provider: ProviderStatus }) {
  const [open, setOpen] = useState(false);
  const [quota, setQuota] = useState<ProviderQuota | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || quota || loading) return;
    setLoading(true);
    api
      .providerUsage(provider.id)
      .then(setQuota)
      .catch(() => setError('Kontingent nicht abrufbar'))
      .finally(() => setLoading(false));
  }, [loading, open, provider.id, quota]);

  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger>
        <ProviderIcon provider={provider.id} className="size-4" />
        {/* The name never gives way; a long version string ("2.1.263 (Claude
            Code)") is the part that may be cut. */}
        <span className="shrink-0">{PROVIDER_LABEL[provider.id]}</span>
        {provider.version && (
          <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground tabular-nums">
            {provider.version}
          </span>
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64 p-3">
        {loading && <p className="text-xs text-muted-foreground">Wird geladen …</p>}
        {!loading && error && <p className="mb-2 text-xs text-destructive">{error}</p>}
        {!loading && !error && quota?.error && (
          <p className="mb-2 text-xs text-destructive">{quota.error}</p>
        )}
        {!loading && !error && quota && !quota.error && quota.windows.length === 0 && (
          <p className="text-xs text-muted-foreground">Kein Kontingent gemeldet.</p>
        )}
        {!loading &&
          !error &&
          quota?.windows.map((window) => (
            <div key={window.kind} className="mb-3 space-y-1 last:mb-0">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="truncate">{window.label}</span>
                <span className="tabular-nums text-muted-foreground">
                  {formatPercent(window.percent)}
                </span>
              </div>
              <Progress value={window.percent} />
              {window.resetsAt && (
                <p className="text-[11px] text-muted-foreground">
                  Zurückgesetzt {formatDateTime(window.resetsAt)}
                </p>
              )}
            </div>
          ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
