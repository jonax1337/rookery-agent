import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { PanelLeftIcon, SearchIcon } from 'lucide-react';
import { useBreadcrumbs } from '@/lib/nav';
import { useConfig, useConnection } from '@/providers/rookery-provider';
import { usePageMetaValue } from '@/components/shell/page-meta';
import { Badge } from '@/components/ui/badge';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { Separator } from '@/components/ui/separator';
import { useSidebar } from '@/components/ui/sidebar';

interface SiteHeaderProps {
  /** Opens the command palette the shell owns. */
  onSearch(): void;
}

/**
 * The one header, above both sidebar and content (sidebar-16).
 *
 * It shows where the reader is, what the page offers, and whether the server
 * is there. Losing the connection used to push a full-width Alert above every
 * page and shove the layout down by four rem; here it is a badge that changes
 * nothing about the geometry.
 */
export function SiteHeader({ onSearch }: SiteHeaderProps) {
  const { toggleSidebar } = useSidebar();
  const { connected, offline } = useConnection();
  const { assistantName } = useConfig();
  const { title, breadcrumb, actions } = usePageMetaValue();
  const { pathname } = useLocation();

  // `ROUTE_META` knows every chain; a page overrides only the leaf it alone
  // knows (a conversation title, an agent's name) or, rarely, the whole chain.
  const fallback = useBreadcrumbs(title);
  const crumbs = breadcrumb ?? fallback;
  const leaf = crumbs[crumbs.length - 1]?.label;

  useEffect(() => {
    document.title = leaf ? leaf + ' · ' + assistantName : assistantName;
  }, [assistantName, leaf]);

  /*
   * Two things this header is the only one who can say out loud.
   *
   * A route change in a single page app is silent: the document title moves,
   * the focus does not, and nothing in the page announces itself. A change of
   * connection is just as silent - the badge below appears and disappears
   * without a word. Both are live regions rather than moved focus, because
   * moving the focus on every navigation would fight the chat composer for it.
   *
   * Both start empty on purpose: a region that mounts with text in it gets
   * read out at page load, which is exactly the noise nobody asked for.
   */
  const [routeMessage, setRouteMessage] = useState('');
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    setRouteMessage(leaf ? leaf + ' geöffnet' : '');
  }, [leaf, pathname]);

  const status = connected ? 'online' : offline ? 'offline' : 'connecting';
  const [connectionMessage, setConnectionMessage] = useState('');
  const lastStatus = useRef(status);
  useEffect(() => {
    if (lastStatus.current === status) return;
    lastStatus.current = status;
    // The same three words the sidebar's foot uses, so both places agree.
    setConnectionMessage(
      status === 'online' ? 'Verbunden' : status === 'offline' ? 'Keine Verbindung' : 'Verbindet …',
    );
  }, [status]);

  return (
    <header className="sticky top-0 z-50 flex w-full items-center border-b bg-background">
      <div className="flex h-(--header-height) w-full items-center gap-2 px-4">
        <Button
          className="h-8 w-8"
          variant="ghost"
          size="icon"
          onClick={toggleSidebar}
          aria-label="Seitenleiste umschalten"
        >
          <PanelLeftIcon />
        </Button>
        <Separator
          orientation="vertical"
          className="mr-2 data-vertical:h-4 data-vertical:self-auto"
        />

        <Breadcrumb className="hidden sm:block">
          <BreadcrumbList>
            {crumbs.map((crumb, index) => (
              <Fragment key={crumb.label + index}>
                {index > 0 && <BreadcrumbSeparator />}
                <BreadcrumbItem>
                  {/*
                    The last crumb is where you already stand, so it never
                    becomes a link - not even when a page hands one a `to`.
                    Guarding it here rather than at every call site is the only
                    way it stays true for pages written later.
                  */}
                  {crumb.to && index < crumbs.length - 1 ? (
                    <BreadcrumbLink asChild>
                      <Link to={crumb.to}>{crumb.label}</Link>
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                  )}
                </BreadcrumbItem>
              </Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
        {/*
          Narrow screens have no room for a chain, only for where you are -
          and from `sm` up the breadcrumb takes that job over visually. The
          heading stays either way: `sr-only` is absolutely positioned and
          takes no room in this flex row, and without it no page in the app
          would have a level-one heading at all.
        */}
        <h1 className="text-base font-medium sm:sr-only">{leaf}</h1>

        {!connected && (
          <Badge variant="destructive" className="ml-1">
            Keine Verbindung
          </Badge>
        )}

        <div className="sr-only" role="status" aria-live="polite">
          {connectionMessage}
        </div>
        <div className="sr-only" role="status" aria-live="polite">
          {routeMessage}
        </div>

        {/*
          `gap-2`, not `gap-1`: page actions are separate controls and have to
          look separate. They used to be welded into a `ButtonGroup`, which is
          built for buttons of one variant - a filled primary glued to an
          outlined secondary reads as a control missing a border.
        */}
        <div className="ml-auto flex items-center gap-2">
          {actions}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onSearch}
            className="hidden w-56 justify-start text-muted-foreground sm:flex"
          >
            <SearchIcon />
            Suchen …
            <KbdGroup className="ml-auto">
              <Kbd>Strg</Kbd>
              <Kbd>K</Kbd>
            </KbdGroup>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onSearch}
            aria-label="Suchen"
            className="sm:hidden"
          >
            <SearchIcon />
          </Button>
        </div>
      </div>
    </header>
  );
}
