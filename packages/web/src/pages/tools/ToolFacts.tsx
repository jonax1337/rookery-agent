import {
  BoxIcon as PackageIcon,
  ExternalLinkIcon,
  FolderOpenIcon as FolderIcon,
  PlugZapIcon as PlugIcon,
  UsersIcon,
} from '@/components/icons';

import { AUDIENCE_LABEL, INSTALL_LABEL } from '@/lib/tools';
import type { Project, ToolServer } from '@/lib/types';
import { MetaList } from '@/components/common/meta-list';

function activityText(tool: ToolServer): string {
  if (tool.active) return 'Running';
  return tool.enabled ? 'Enabled but not ready' : 'Off';
}

function projectsText(tool: ToolServer, projects: readonly Project[]): string {
  if (tool.projectIds.length === 0) return 'All projects';
  return tool.projectIds
    .map((id) => projects.find((project) => project.id === id)?.name ?? id)
    .join(', ');
}

/** An external address, so a plain anchor - `MetaList.to` routes inside the app and would swallow it. */
function HomepageLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 hover:underline"
    >
      <span className="truncate">{href.replace(/^https?:\/\//, '')}</span>
      <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
    </a>
  );
}

export function ToolFacts({ tool, projects }: { tool: ToolServer; projects: readonly Project[] }) {
  return (
    <MetaList
      columns={2}
      items={[
        { label: 'Audience', value: AUDIENCE_LABEL[tool.audience], icon: UsersIcon },
        { label: 'Source', value: INSTALL_LABEL[tool.install], icon: PackageIcon },
        {
          label: 'Installed',
          value: tool.installed ? 'Yes' : 'Not downloaded yet',
          icon: PlugIcon,
        },
        { label: 'Active', value: activityText(tool), icon: PlugIcon },
        { label: 'Projects', value: projectsText(tool, projects), icon: FolderIcon },
        {
          label: 'Project page',
          value: tool.homepage ? <HomepageLink href={tool.homepage} /> : '',
          icon: ExternalLinkIcon,
        },
      ]}
    />
  );
}
