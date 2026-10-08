import {
  AudioLinesIcon as AudioLines,
  ClipboardCheckIcon as ClipboardList,
  ClockIcon as Clock,
  BellIcon as Bell,
  LayoutGridIcon as LayoutDashboard,
  MessageSquareIcon as MessageSquare,
  RadioTowerIcon as RadioTower,
  SendIcon as Send,
  SlidersHorizontalIcon as SlidersHorizontal,
  WrenchIcon as Wrench,
} from "@/components/icons";

/**
 * The route icons, as their lucide-animated twins.
 *
 * The animated icons find their interactive host themselves (`useHostHover`
 * walks up to the sidebar link, the palette option) and play when the *row*
 * is hovered, not only the icon's own pixels - so no wrapper is needed.
 */
export const OverviewIcon = LayoutDashboard;
export const ConversationsIcon = MessageSquare;
export const VoiceIcon = AudioLines;
export const TasksIcon = ClipboardList;
export const AssignmentsIcon = Send;
export const SchedulesIcon = Clock;
export const GatewaysIcon = RadioTower;
/** The notifications route keeps its `/inbox` path and `InboxIcon` name. */
export const InboxIcon = Bell;
// A wrench, not sparkles: skills are crafted, not conjured - and the plug
// took the MCP job on the tools route.
export const SkillsIcon = Wrench;
export const SettingsIcon = SlidersHorizontal;
