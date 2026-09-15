import { useEffect, useRef, useState, type ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';

import { AudioLines } from '@/components/animate-ui/icons/audio-lines';
import { ClipboardList } from '@/components/animate-ui/icons/clipboard-list';
import { Clock } from '@/components/animate-ui/icons/clock';
import { LayoutDashboard } from '@/components/animate-ui/icons/layout-dashboard';
import { MessageSquare } from '@/components/animate-ui/icons/message-square';
import { RadioTower } from '@/components/animate-ui/icons/radio-tower';
import { Send } from '@/components/animate-ui/icons/send';
import { SlidersHorizontal } from '@/components/animate-ui/icons/sliders-horizontal';
import { Sparkles } from '@/components/animate-ui/icons/sparkles';

type PlayableIcon = ComponentType<{
  className?: string;
  /** animate-ui's controlled trigger: true plays once, false resets. */
  animate?: boolean;
}>;

/**
 * An animate-ui icon as the `icon: LucideIcon` slot of the route table wants
 * it: same silhouette as its lucide original, but the strokes play when the
 * *row* is hovered, not only the icon's own 16px - `animateOnHover` fires on
 * the icon span itself, and a row is mostly label. The wrapper finds its row
 * (sidebar link, palette option) and drives the icon through the controlled
 * `animate` prop, so re-entering replays it. The `as unknown as LucideIcon`
 * cast is the established bridge from the pages' empty states, where
 * `EmptyState` types the same way and renders its icons without props.
 */
function hoverRowIcon(Icon: PlayableIcon): LucideIcon {
  function RowIcon() {
    const [play, setPlay] = useState(false);
    const anchor = useRef<HTMLSpanElement>(null);

    useEffect(() => {
      const row = anchor.current?.closest('a, button, [role="option"]');
      if (!row) return;
      const enter = () => setPlay(true);
      const leave = () => setPlay(false);
      row.addEventListener('mouseenter', enter);
      row.addEventListener('mouseleave', leave);
      return () => {
        row.removeEventListener('mouseenter', enter);
        row.removeEventListener('mouseleave', leave);
      };
    }, []);

    return (
      <span ref={anchor} className="inline-flex">
        <Icon className="size-4" animate={play} />
      </span>
    );
  }
  return RowIcon as unknown as LucideIcon;
}

/** One per animated route; the routes without a registry twin stay lucide. */
export const OverviewIcon = hoverRowIcon(LayoutDashboard);
export const ConversationsIcon = hoverRowIcon(MessageSquare);
export const VoiceIcon = hoverRowIcon(AudioLines);
export const TasksIcon = hoverRowIcon(ClipboardList);
export const AssignmentsIcon = hoverRowIcon(Send);
export const SchedulesIcon = hoverRowIcon(Clock);
export const GatewaysIcon = hoverRowIcon(RadioTower);
export const SkillsIcon = hoverRowIcon(Sparkles);
export const SettingsIcon = hoverRowIcon(SlidersHorizontal);
