import type { IconComponent } from "@/components/icons";

import {
  BadgeAlertIcon as TriangleAlertIcon,
  BanIcon as OctagonXIcon,
  BellIcon,
  BookTextIcon as BookOpenIcon,
  BotIcon,
  ChartBarIncreasingIcon as ChartBarIcon,
  ChartPieIcon as PieChartIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronLeftIcon as ChevronsLeftIcon,
  ChevronRightIcon,
  ChevronRightIcon as ChevronsRightIcon,
  ChevronUpIcon,
  ChevronsUpDownIcon,
  CircleCheckIcon,
  CircleCheckIcon as BadgeCheckIcon,
  CircleDashedIcon as CircleIcon,
  CircleHelpIcon,
  CircleHelpIcon as InfoIcon,
  CircleHelpIcon as LifeBuoyIcon,
  CreditCardIcon,
  DatabaseBackupIcon as DatabaseIcon,
  DeleteIcon as Trash2Icon,
  FileChartLineIcon as FileChartColumnIcon,
  FileTextIcon,
  FileTextIcon as FileIcon,
  FolderOpenIcon as FolderIcon,
  FrameIcon,
  GalleryThumbnailsIcon as Columns3Icon,
  GripHorizontalIcon as MoreHorizontalIcon,
  GripVerticalIcon,
  GripVerticalIcon as EllipsisVerticalIcon,
  KeyboardIcon as CommandIcon,
  LayoutGridIcon as LayoutDashboardIcon,
  LinkIcon as ShareIcon,
  LoaderCircleIcon as Loader2Icon,
  LoaderIcon,
  LogoutIcon as LogOutIcon,
  MailboxIcon as MailIcon,
  MapPinIcon as MapIcon,
  MenuIcon as ListIcon,
  PanelLeftCloseIcon as PanelLeftIcon,
  PlusIcon,
  PlusIcon as CirclePlusIcon,
  SearchIcon,
  SendIcon,
  SlidersHorizontalIcon as Settings2Icon,
  SparklesIcon,
  SwitchCameraIcon as CameraIcon,
  TerminalIcon,
  TerminalIcon as TerminalSquareIcon,
  TrendingDownIcon,
  TrendingUpIcon,
  UserIcon as CircleUserRoundIcon,
  UsersIcon,
  XIcon,
} from "@/components/icons";

/**
 * Icon resolver for the shadcn registry components.
 *
 * Registry sources call <IconPlaceholder lucide="CheckIcon" tabler="..." .../>
 * so one file can serve every icon library. Rookery uses lucide, and the icons
 * are imported by name rather than looked up on the library namespace, so the
 * bundle only carries the ones actually referenced. Add a name here when a
 * freshly pulled block asks for an icon this map does not know yet.
 */
const ICONS: Record<string, IconComponent> = {
  BadgeCheckIcon,
  BellIcon,
  BookOpenIcon,
  BotIcon,
  CameraIcon,
  ChartBarIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  ChevronsUpDownIcon,
  ChevronUpIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  CirclePlusIcon,
  CircleUserRoundIcon,
  Columns3Icon,
  CommandIcon,
  CreditCardIcon,
  DatabaseIcon,
  EllipsisVerticalIcon,
  FileChartColumnIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  FrameIcon,
  GripVerticalIcon,
  InfoIcon,
  LayoutDashboardIcon,
  LifeBuoyIcon,
  ListIcon,
  Loader2Icon,
  LoaderIcon,
  LogOutIcon,
  MailIcon,
  MapIcon,
  MoreHorizontalIcon,
  OctagonXIcon,
  PanelLeftIcon,
  PieChartIcon,
  PlusIcon,
  SearchIcon,
  SendIcon,
  Settings2Icon,
  ShareIcon,
  SparklesIcon,
  TerminalIcon,
  TerminalSquareIcon,
  Trash2Icon,
  TrendingDownIcon,
  TrendingUpIcon,
  TriangleAlertIcon,
  UsersIcon,
  XIcon,
};

interface IconPlaceholderProps {
  lucide: string;
  className?: string;
  size?: number;
  /* Accepted and ignored: the registry passes one name per icon library. */
  tabler?: string;
  hugeicons?: string;
  phosphor?: string;
  remixicon?: string;
}

export function IconPlaceholder({
  lucide,
  tabler: _tabler,
  hugeicons: _hugeicons,
  phosphor: _phosphor,
  remixicon: _remixicon,
  ...props
}: IconPlaceholderProps) {
  const Icon = ICONS[lucide] ?? CircleIcon;
  return <Icon {...props} />;
}
