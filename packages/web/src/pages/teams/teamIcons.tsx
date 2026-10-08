import { forwardRef } from 'react';

import {
  DeleteIcon as AnimatedTrash2Icon,
  UsersRoundIcon as AnimatedUsersRoundIcon,
} from '@/components/icons';

/**
 * The empty-state and menu icons as animate-ui twins: same paths and stroke
 * as the lucide originals, wiggling once when they enter the viewport (the
 * menu item, whenever the menu opens). `EmptyState` and the form header
 * menu take a `IconComponent` and render it without props, so each animated
 * icon sits in a forwardRef shell that carries its trigger along.
 */
export const EmptyUsersRoundIcon = forwardRef<SVGSVGElement>(function EmptyUsersRoundIcon() {
  return <AnimatedUsersRoundIcon />;
});

export const MenuTrash2Icon = forwardRef<SVGSVGElement>(function MenuTrash2Icon() {
  return <AnimatedTrash2Icon />;
});
