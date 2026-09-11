import { useLocation, useNavigate } from 'react-router';
import { CompassIcon } from 'lucide-react';

import { PageBody } from '@/components/blocks/page-body';
import { EmptyState } from '@/components/common/empty-state';
import { usePageMeta } from '@/components/shell/page-meta';
import { Button } from '@/components/ui/button';
import { Kbd, KbdGroup } from '@/components/ui/kbd';

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

  usePageMeta({ breadcrumb: [{ label: 'Nicht gefunden' }] });

  // The palette belongs to the shell and takes no handle from a page. It does
  // listen for Strg/Cmd+K on the document, though, so the button presses the
  // same key a person would - no new prop through two components for one link.
  const openPalette = (): void => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
  };

  return (
    <PageBody width="2xl">
      <EmptyState
        icon={CompassIcon}
        title="Diese Seite gibt es nicht"
        description={
          <>
            Unter <span className="font-mono text-foreground">{pathname}</span> liegt nichts. Der Link
            ist veraltet oder vertippt.
          </>
        }
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button type="button" onClick={() => void navigate('/dashboard')}>
              Zur Übersicht
            </Button>
            <Button type="button" variant="outline" onClick={openPalette}>
              Suchen
              <KbdGroup>
                <Kbd>Strg</Kbd>
                <Kbd>K</Kbd>
              </KbdGroup>
            </Button>
          </div>
        }
      />
    </PageBody>
  );
}
