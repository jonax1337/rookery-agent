import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router';

import { cn } from '@/lib/utils';

/**
 * The page frame from `dashboard-01/page.tsx`.
 *
 * Three nested divs, kept in that order because each one does a job: the
 * outer one is the scroll container (the shell's `SidebarInset` is
 * `overflow-hidden` so the assistant-ui thread keeps its own scroller, which
 * means the page has to bring its own), the middle one opens the
 * `@container/main` query that every block below reads for its column counts,
 * and the inner one carries the vertical rhythm.
 *
 * The chat route deliberately does NOT use this: it needs the raw inset so
 * the thread can own the viewport.
 */

/**
 * How wide the content may get. `full` is the dashboard case - the blocks
 * bring their own `px-4 lg:px-6`. Every narrower value is a reading measure
 * for forms and detail pages, and it brings the horizontal padding along,
 * because a constrained page has no full-bleed children to pad themselves.
 */
export type PageWidth = 'full' | '5xl' | '4xl' | '3xl' | '2xl';

const MEASURE: Record<PageWidth, string> = {
  full: '',
  '5xl': 'mx-auto w-full max-w-5xl',
  '4xl': 'mx-auto w-full max-w-4xl',
  '3xl': 'mx-auto w-full max-w-3xl',
  '2xl': 'mx-auto w-full max-w-2xl',
};

export interface PageBodyProps {
  width?: PageWidth;
  /** A viewport-bound workspace, such as the network, owns its remaining height. */
  scroll?: boolean;
  /** Lands on the rhythm container, not the scroller - spacing overrides. */
  className?: string;
  children: ReactNode;
}

export function PageBody({ width = 'full', scroll = true, className, children }: PageBodyProps) {
  const constrained = width !== 'full';
  const scrollRef = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();

  // Nested routes reuse this scroller; filters on the same route keep their place.
  useLayoutEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div
      ref={scrollRef}
      // `scrollbar-gutter: stable` keeps the content width still when a tab or
      // filter drops the content below the viewport height - without it the
      // disappearing scrollbar makes the whole table jump 10px sideways.
      className={cn('flex min-h-0 flex-1 flex-col', scroll ? 'overflow-y-auto [scrollbar-gutter:stable]' : 'overflow-hidden')}
    >
      {/*
        The measure sits on the container-query element on purpose: a card row
        inside a 2xl page should count its columns against 2xl, not against the
        viewport, or a form page would sprout four stat columns.
      */}
      <div className={cn('@container/main flex flex-1 flex-col gap-2', !scroll && 'min-h-0', MEASURE[width])}>
        <div
          className={cn(
            'flex flex-col gap-4 py-4 md:gap-6 md:py-6',
            !scroll && 'min-h-0 flex-1',
            constrained && 'px-4 lg:px-6',
            className,
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
