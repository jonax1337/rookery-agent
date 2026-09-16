import * as React from 'react';
import { NavLink } from 'react-router';

import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { cn } from '@/lib/utils';
import type { IconComponent } from "@/components/icons";
import {
  PlugZapIcon,
  SearchIcon as SearchXIcon,
  ServerCrashIcon as ServerOffIcon,
} from "@/components/icons";

/**
 * The one way this app says "nothing here".
 *
 * It replaces the roughly twenty-five bare `<p>Keine …</p>` paragraphs the
 * pages grew independently: those said what was missing but never what to do
 * about it, and each one sat at a different size in a different place. A
 * symbol, a sentence and a way forward - that is the whole contract, and the
 * call to action is the part that earns the component.
 *
 * Motion: the block fades in where it mounts and the way forward joins a tenth
 * of a second later, so the eye lands on the symbol before the remedy. Icons
 * with an animate-ui twin (the reconnect plug) pulse once in view.
 */

export interface EmptyStateProps {
  /** Imported straight from `lucide-react`, never through `IconPlaceholder`. */
  icon?: IconComponent;
  title: string;
  /** One sentence. Says why it is empty, not that it is empty. */
  description?: React.ReactNode;
  /**
   * The way out. Either a route (`actionTo`) or a handler (`onAction`); pass
   * `action` instead when the button needs to be something else entirely.
   */
  actionLabel?: string;
  actionTo?: string;
  onAction?: () => void;
  /** A free slot, rendered below the action. Buttons, a hint, a link. */
  action?: React.ReactNode;
  /**
   * `outline` draws the dashed frame a table body or a card wants,
   * `plain` leaves it off where a card already provides the border.
   */
  variant?: 'outline' | 'plain';
  /** `sm` fits inside a table body or a drawer; `default` owns the page. */
  size?: 'default' | 'sm';
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  actionTo,
  onAction,
  action,
  variant = 'outline',
  size = 'default',
  className,
}: EmptyStateProps) {
  const hasButton = Boolean(actionLabel && (actionTo || onAction));

  return (
    <Fade asChild>
      <Empty
        className={cn(
          variant === 'outline' && 'border',
          size === 'sm' && 'gap-3 p-6',
          className,
        )}
      >
        <EmptyHeader>
          {Icon && (
            <EmptyMedia variant="icon" className={cn(size === 'sm' && 'mb-1 size-8')}>
              <Icon />
            </EmptyMedia>
          )}
          <EmptyTitle className={cn(size === 'sm' && 'text-base')}>{title}</EmptyTitle>
          {description && <EmptyDescription>{description}</EmptyDescription>}
        </EmptyHeader>

        {(hasButton || action) && (
          <Fade asChild delay={100}>
            <EmptyContent>
              {hasButton &&
                (actionTo ? (
                  <Button asChild size={size === 'sm' ? 'sm' : 'default'}>
                    <NavLink to={actionTo}>{actionLabel}</NavLink>
                  </Button>
                ) : (
                  <Button type="button" size={size === 'sm' ? 'sm' : 'default'} onClick={onAction}>
                    {actionLabel}
                  </Button>
                ))}
              {action}
            </EmptyContent>
          </Fade>
        )}
      </Empty>
    </Fade>
  );
}

/**
 * The reconnect empty state swaps its lucide plug for the animate-ui one:
 * same silhouette and stroke, the bolt pulses once when the state enters
 * the viewport. `EmptyState` types its `icon` as a `IconComponent` and renders
 * it without props, so the `animateOnView` trigger rides along in this shell.
 */
const AnimatedPlugZapIcon = React.forwardRef<SVGSVGElement>(function AnimatedPlugZapIcon() {
  return <PlugZapIcon size={24} />;
});

/**
 * The server is not answering.
 *
 * Worth its own component because the honest answer differs from an empty
 * list: the page does not know whether there is data, so it must not claim
 * there is none. Every list that can go offline shows this instead.
 */
export function ServerOffline({
  onRetry,
  className,
  size,
}: {
  onRetry?: () => void;
  className?: string;
  size?: EmptyStateProps['size'];
}) {
  return (
    <EmptyState
      icon={onRetry ? AnimatedPlugZapIcon : ServerOffIcon}
      title="No connection to the Rookery server"
      description="The data on this page may be out of date. Is the server still running?"
      actionLabel={onRetry ? 'Try again' : undefined}
      onAction={onRetry}
      size={size ?? 'default'}
      className={className}
    />
  );
}

/**
 * A filter or a search term that matched nothing - which is not the same as
 * having nothing, so it offers to clear the filter rather than to create.
 */
export function NoResults({
  query,
  onReset,
  className,
  size = 'sm',
}: {
  /** Shown in quotes when the miss came from a search field. */
  query?: string;
  onReset?: () => void;
  className?: string;
  size?: EmptyStateProps['size'];
}) {
  return (
    <EmptyState
      icon={SearchXIcon}
      title="Nothing found"
      description={
        query
          ? 'Nothing here matches “' + query + '”. Try a shorter search term.'
          : 'Nothing matches the selected filters. Removing a filter may show more.'
      }
      actionLabel={onReset ? 'Reset filters' : undefined}
      onAction={onReset}
      variant="plain"
      size={size}
      className={className}
    />
  );
}
