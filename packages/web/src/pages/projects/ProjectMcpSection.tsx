import { PlugZapIcon as PlugZap } from '@/components/icons';
import { CountingNumber } from '@/components/animate-ui/primitives/texts/counting-number';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldDescription, FieldLegend, FieldSet } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import type { ProjectMcpInfo } from '@/lib/types';

import { useProjectMcp } from './useProjectMcp';

type McpStatus = ProjectMcpInfo['status'];

const MCP_STATUS_LABEL: Record<McpStatus, string> = {
  none: 'No servers',
  pending: 'Not yet trusted',
  trusted: 'Trusted',
  changed: 'Changed since approval',
};

const MCP_STATUS_VARIANT: Record<McpStatus, 'secondary' | 'destructive' | 'outline'> = {
  none: 'outline',
  pending: 'outline',
  trusted: 'secondary',
  changed: 'destructive',
};

interface ProjectMcpSectionProps {
  projectId: string;
  directory: string;
}

/** The servers a project's `.mcp.json` declares, and the switch that lets assignments start them. */
export function ProjectMcpSection({ projectId, directory }: ProjectMcpSectionProps) {
  const { info, loading, busy, error, trust, revoke } = useProjectMcp(projectId, directory);

  return (
    <FieldSet>
      <FieldLegend variant="label">MCP servers</FieldLegend>
      <FieldDescription>
        Servers listed in this project&rsquo;s own .mcp.json - the same file a person&rsquo;s own
        Claude Code session in this folder would read. Starting them for an assignment needs
        approval here first, and an edit to the file needs approving again.
      </FieldDescription>
      {loading ? (
        <Spinner aria-label="Loading" />
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : info && info.servers.length ? (
        <McpServersCard info={info} busy={busy} onTrust={trust} onRevoke={revoke} />
      ) : (
        <FieldDescription>No .mcp.json in this directory.</FieldDescription>
      )}
    </FieldSet>
  );
}

interface McpServersCardProps {
  info: ProjectMcpInfo;
  busy: boolean;
  onTrust(): Promise<void>;
  onRevoke(): Promise<void>;
}

function McpServersCard({ info, busy, onTrust, onRevoke }: McpServersCardProps) {
  const trusted = info.status === 'trusted';

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <div>
          <CardTitle>
            <Badge variant={MCP_STATUS_VARIANT[info.status]}>{MCP_STATUS_LABEL[info.status]}</Badge>
          </CardTitle>
          <CardDescription>
            <CountingNumber number={info.servers.length} /> server
            {info.servers.length === 1 ? '' : 's'} declared.
          </CardDescription>
        </div>
        <Button
          type="button"
          size="sm"
          variant={trusted ? 'outline' : 'default'}
          disabled={busy}
          onClick={() => void (trusted ? onRevoke() : onTrust())}
        >
          {busy ? <Spinner aria-label="Working" data-icon="inline-start" /> : <PlugZap />}
          {trusted ? 'Revoke' : 'Trust'}
        </Button>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-1.5">
          {info.servers.map((server) => (
            <li key={server.name} className="font-mono text-xs">
              {server.name}: {server.command} {server.args.join(' ')}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
