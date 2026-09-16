import { useLocation, useNavigate } from 'react-router';

import { Blur } from '@/components/animate-ui/primitives/effects/blur';
import { RollingText } from '@/components/animate-ui/primitives/texts/rolling';
import { PageBody } from '@/components/blocks/page-body';
import { usePageMeta } from '@/components/shell/page-meta';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { CompassIcon as AnimatedCompassIcon } from '@/components/icons';

/**
 * A route nobody has.
 *
 * The catch-all used to be `<Navigate to="/" replace />`, which swallowed the
 * mistake: a mistyped or outdated link dropped a person into the chat with no
 * hint that anything had gone wrong, and the address bar quietly lost the
 * path they had actually asked for. So the path is printed back, and the two
 * ways on are the two the app has - the overview, and the palette that can
 * find any page by name.
 */
export function NotFoundPage() {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  usePageMeta({ breadcrumb: [{ label: 'Not found' }] });

  // The palette belongs to the shell and takes no handle from a page. It does
  // listen for Ctrl/Cmd+K on the document, though, so the button presses the
  // same key a person would - no new prop through two components for one link.
  const openPalette = (): void => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
  };

  return (
    <PageBody width="2xl">
      {/* Spelled out with the same `ui/empty` primitives EmptyState uses
          (variant "outline", size "default" - so `border` on the frame)
          because its `icon` prop takes a plain lucide component and renders
          it without animation props: inline, the compass and the title get
          to move. The Blur wrapper carries the flex growth the card had as
          a direct child of the page rhythm, so it still owns the page. */}
      <Blur className="flex flex-1 flex-col">
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AnimatedCompassIcon />
            </EmptyMedia>
            <EmptyTitle>
              <RollingText text="This page does not exist" />
            </EmptyTitle>
            <EmptyDescription>
              <span className="font-mono text-foreground">{pathname}</span> was not found. The link may
              be outdated or mistyped.
            </EmptyDescription>
          </EmptyHeader>

          <EmptyContent>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button type="button" onClick={() => void navigate('/dashboard')}>
                Go to dashboard
              </Button>
              <Button type="button" variant="outline" onClick={openPalette}>
                Search
                <KbdGroup>
                  <Kbd>Ctrl</Kbd>
                  <Kbd>K</Kbd>
                </KbdGroup>
              </Button>
            </div>
          </EmptyContent>
        </Empty>
      </Blur>
    </PageBody>
  );
}
