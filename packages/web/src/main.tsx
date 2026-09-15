import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { MotionConfig } from 'motion/react';
import { ThemeProvider } from 'next-themes';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import {
  RookeryComposerSlots,
  RookeryProvider,
  RookeryRuntimeProvider,
} from '@/providers/rookery-provider';
import { PageMetaProvider } from '@/components/shell/page-meta';
import App from './App';
import './styles/index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element is missing from index.html');

/**
 * The provider tree, outside the router's own switching so nothing below it
 * remounts on navigation. `RookeryProvider` sits inside `BrowserRouter`
 * because it puts the open conversation into the URL.
 *
 * The `Toaster` is mounted exactly once. It used to be rendered twice - once
 * in the hands-free branch, once in the normal one - which meant two portals
 * and, for a moment during the switch, two copies of the same toast.
 */
createRoot(container).render(
  <StrictMode>
    {/* Every motion animation in the app respects the user's
        prefers-reduced-motion setting from this one place. */}
    <MotionConfig reducedMotion="user">
      <BrowserRouter>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <TooltipProvider delayDuration={350}>
            <RookeryProvider>
              <PageMetaProvider>
                <RookeryRuntimeProvider>
                  <RookeryComposerSlots>
                    <App />
                    <Toaster />
                  </RookeryComposerSlots>
                </RookeryRuntimeProvider>
              </PageMetaProvider>
            </RookeryProvider>
          </TooltipProvider>
        </ThemeProvider>
      </BrowserRouter>
    </MotionConfig>
  </StrictMode>,
);
