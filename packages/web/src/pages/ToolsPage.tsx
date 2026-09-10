import { useCallback, useEffect, useState } from 'react';
import { NavLink } from 'react-router';
import { PlusIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { ToolServer } from '@/lib/types';
import { AUDIENCE_LABEL, toolStatus } from '@/lib/tools';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';

/** The MCP hub as a list; every row opens its own page for options and keys. */
export function ToolsPage() {
  const [tools, setTools] = useState<ToolServer[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setTools(await api.tools());
    } catch (caught) {
      toast.error('Werkzeuge konnten nicht geladen werden', { description: (caught as Error).message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (tool: ToolServer, on: boolean): Promise<void> => {
    try {
      const updated = await api.updateTool(tool.id, { enabled: on });
      setTools((current) => current.map((entry) => (entry.id === tool.id ? updated : entry)));
      toast(tool.name + (on ? ' eingeschaltet' : ' ausgeschaltet'));
    } catch (caught) {
      toast.error('Änderung fehlgeschlagen', { description: (caught as Error).message });
    }
  };

  const catalogue = tools.filter((tool) => tool.install !== 'custom');
  const custom = tools.filter((tool) => tool.install === 'custom');

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Werkzeuge</h1>
            <p className="text-sm text-muted-foreground">
              MCP-Server, die der Assistent und die Agenten in jedem Turn bekommen, im Chat, in der CLI und
              im Sprachmodus. Ein Schalter gilt ab dem nächsten Turn.
            </p>
          </div>
          <Button asChild>
            <NavLink to="/tools/new">
              <PlusIcon />
              Eigener Server
            </NavLink>
          </Button>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Wird geladen …</p>
        ) : (
          <>
            <ToolList tools={catalogue} onToggle={toggle} />
            {custom.length > 0 && (
              <div className="space-y-2">
                <h2 className="text-sm font-medium text-muted-foreground">Eigene Server</h2>
                <ToolList tools={custom} onToggle={toggle} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ToolList({ tools, onToggle }: { tools: ToolServer[]; onToggle(tool: ToolServer, on: boolean): Promise<void> }) {
  return (
    <Card>
      <CardContent>
        <ul className="divide-y">
          {tools.map((tool) => {
            const status = toolStatus(tool);
            return (
              <li key={tool.id} className="flex items-center gap-4 py-3">
                <span
                  aria-hidden
                  className={
                    'size-2 shrink-0 rounded-full ' +
                    (status.tone === 'on' ? 'bg-emerald-500' : status.tone === 'blocked' ? 'bg-amber-500' : 'bg-muted-foreground/30')
                  }
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <NavLink to={'/tools/' + tool.id} className="font-medium hover:underline">
                      {tool.name}
                    </NavLink>
                    <Badge variant="outline" className="h-5 font-normal text-muted-foreground">
                      {AUDIENCE_LABEL[tool.audience]}
                    </Badge>
                    {status.tone === 'blocked' && (
                      <Badge variant="outline" className="h-5 font-normal text-amber-600 dark:text-amber-400">
                        {status.label}
                      </Badge>
                    )}
                  </div>
                  <p className="truncate text-sm text-muted-foreground">{tool.description}</p>
                </div>
                <Switch
                  aria-label={tool.name + ' einschalten'}
                  checked={tool.enabled}
                  disabled={!tool.installed}
                  onCheckedChange={(on) => void onToggle(tool, on)}
                />
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
