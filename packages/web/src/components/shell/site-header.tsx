import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { ArrowLeftIcon, PanelLeftIcon, SearchIcon } from 'lucide-react';
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
  const parent = crumbs.slice(0, -1).reverse().find((crumb) => crumb.to && crumb.to !== pathname);

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
  const lastLeaf = useRef(leaf);
  useEffect(() => {
    if (lastPath.current === pathname && lastLeaf.current === leaf) return;
    lastPath.current = pathname;
    lastLeaf.current = leaf;
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
    <header className="sticky top-0 z-50 flex w-full shrink-0 items-center border-b bg-background">
      <div className="flex min-h-(--header-height) w-full flex-wrap items-center gap-2 px-4 py-2 sm:h-(--header-height) sm:flex-nowrap sm:py-0">
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
          className="mr-2 hidden data-vertical:h-4 data-vertical:self-auto sm:block"
        />
        {parent?.to ? (
          <Button variant="ghost" size="icon" className="size-8 shrink-0 sm:hidden" asChild>
            <Link to={parent.to} aria-label={'Zurück: ' + parent.label}>
              <ArrowLeftIcon />
            </Link>
          </Button>
        ) : null}

        <Breadcrumb className="hidden min-w-0 flex-1 sm:block">
          <BreadcrumbList className="flex-nowrap">
            {crumbs.map((crumb, index) => (
              <Fragment key={crumb.label + index}>
                {index > 0 && <BreadcrumbSeparator />}
                <BreadcrumbItem className="min-w-0">
                  {/*
                    The last crumb is where you already stand, so it never
                    becomes a link - not even when a page hands one a `to`.
                    Guarding it here rather than at every call site is the only
                    way it stays true for pages written later.
                  */}
                  {crumb.to && index < crumbs.length - 1 ? (
                    <BreadcrumbLink asChild>
                      <Link to={crumb.to} className="truncate">{crumb.label}</Link>
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage className="truncate">{crumb.label}</BreadcrumbPage>
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
        <h1 className="min-w-0 flex-1 truncate text-base font-medium sm:sr-only">{leaf}</h1>

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
        {actions ? (
          <div className="order-last flex w-full min-w-0 flex-wrap items-center justify-end gap-2 [&>div]:max-w-full [&>div]:flex-wrap has-[>[data-size=icon-sm]:only-child]:order-none has-[>[data-size=icon-sm]:only-child]:w-auto sm:order-none sm:ml-auto sm:w-auto">
            {actions}
          </div>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2 sm:ml-0">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onSearch}
            className="hidden w-56 justify-start text-muted-foreground xl:flex"
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
            className="xl:hidden"
          >
            <SearchIcon />
          </Button>
        </div>
      </div>
    </header>
  );
}
