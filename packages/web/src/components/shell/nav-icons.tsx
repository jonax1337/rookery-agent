import {
  AudioLinesIcon as AudioLines,
  ClipboardCheckIcon as ClipboardList,
  ClockIcon as Clock,
  LayoutGridIcon as LayoutDashboard,
  MailboxIcon as Mail,
  MessageSquareIcon as MessageSquare,
  RadioTowerIcon as RadioTower,
  SendIcon as Send,
  SlidersHorizontalIcon as SlidersHorizontal,
  WrenchIcon as Wrench,
} from "@/components/icons";

/**
 * The route icons, as their lucide-animated twins.
 *
 * No wrapper any more: the animated icons find their interactive host
 * themselves (`useHostHover` walks up to the sidebar link, the palette
 * option) and play when the *row* is hovered, not only the icon's own
 * pixels. The old `hoverRowIcon` bridge drove them through a controlled
 * `animate` prop the registry icons never had - the prop landed on the
 * motion component and overrode `animate={controls}`, which is why the
 * Gateway and Conversations rows never played.
 */
export const OverviewIcon = LayoutDashboard;
export const ConversationsIcon = MessageSquare;
export const VoiceIcon = AudioLines;
export const TasksIcon = ClipboardList;
export const AssignmentsIcon = Send;
export const SchedulesIcon = Clock;
export const GatewaysIcon = RadioTower;
export const InboxIcon = Mail;
// A wrench, not sparkles: skills are crafted, not conjured - and the plug
// took the MCP job on the tools route.
export const SkillsIcon = Wrench;
export const SettingsIcon = SlidersHorizontal;
