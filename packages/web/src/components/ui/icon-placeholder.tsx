import type { LucideProps } from 'lucide-react';
import {
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
  CircleIcon,
} from 'lucide-react';

/**
 * Icon resolver for the shadcn registry components.
 *
 * Registry sources call <IconPlaceholder lucide="CheckIcon" tabler="..." .../>
 * so one file can serve every icon library. Rookery uses lucide, and the icons
 * are imported by name rather than looked up on the library namespace, so the
 * bundle only carries the ones actually referenced. Add a name here when a
 * freshly pulled block asks for an icon this map does not know yet.
 */
const ICONS: Record<string, React.ComponentType<LucideProps>> = {
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

interface IconPlaceholderProps extends LucideProps {
  lucide: string;
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
