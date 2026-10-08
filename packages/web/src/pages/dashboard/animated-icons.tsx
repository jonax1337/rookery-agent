import { forwardRef } from 'react';

import { ActivityIcon, BotIcon, SendIcon } from '@/components/icons';

/**
 * The empty states draw their icon in when it enters the view. `EmptyState`
 * takes its icon as an `IconComponent`, which these `forwardRef` shells satisfy
 * for the animated equivalents - the explicit `size` keeps the 24px the
 * lucide default rests at (animate-ui would otherwise rest at 28 and grow
 * the media circle).
 */
export const AnimatedActivityIcon = forwardRef<SVGSVGElement>(function AnimatedActivityIcon() {
  return <ActivityIcon size={24} />;
});

export const AnimatedBotIcon = forwardRef<SVGSVGElement>(function AnimatedBotIcon() {
  return <BotIcon size={24} />;
});

export const AnimatedSendIcon = forwardRef<SVGSVGElement>(function AnimatedSendIcon() {
  return <SendIcon size={24} />;
});
