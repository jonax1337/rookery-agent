import { useCallback, useState } from 'react';

import { DeleteIcon as Trash2Icon, RotateCcwIcon } from '@/components/icons';
import { toast } from 'sonner';

import { failureMessage, reportFailure } from '@/lib/errors';
import type { ToolServer } from '@/lib/types';
import type { ToolsState } from '@/hooks/useTools';
import { DetailDrawer } from '@/components/blocks/detail-drawer';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';

/** Switches a server on or off and says so; a refusal is reported, not thrown. */
export function useToggleTool(setEnabled: ToolsState['setEnabled']) {
  return useCallback(
    async (tool: ToolServer, on: boolean): Promise<void> => {
      try {
        await setEnabled(tool.id, on);
        toast(tool.name + (on ? ' enabled' : ' disabled'));
      } catch (caught) {
        reportFailure('Update', caught);
      }
    },
    [setEnabled],
  );
}

/** What a finished preparation had to say, held for the drawer. */
interface PrepareResult {
  tool: ToolServer;
  ok: boolean;
  output: string;
}

/** A server's one-off preparation (e.g. a download), with the output it printed. */
export function usePrepareTool(prepare: ToolsState['prepare']) {
  const [preparingId, setPreparingId] = useState<string | null>(null);
  const [result, setResult] = useState<PrepareResult | null>(null);

  const run = useCallback(
    async (tool: ToolServer): Promise<void> => {
      setPreparingId(tool.id);
      try {
        const outcome = await prepare(tool.id);
        setResult({ tool, ok: outcome.ok, output: outcome.output });
      } catch (caught) {
        // The panel prints this verbatim, so a stopped server has to reach it
        // as a sentence rather than as the browser's "Failed to fetch".
        setResult({ tool, ok: false, output: failureMessage(caught) });
      } finally {
        setPreparingId(null);
      }
    },
    [prepare],
  );

  const dismiss = useCallback(() => setResult(null), []);

  return { preparingId, result, run, dismiss };
}

/** The preparation can print a whole npm log; a toast would swallow it. */
export function PrepareOutputDrawer({
  result,
  onDismiss,
}: {
  result: PrepareResult | null;
  onDismiss(): void;
}) {
  return (
    <DetailDrawer
      open={result !== null}
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
      title={result ? result.tool.name + ' set up' : 'Setup'}
      description={result ? (result.ok ? 'Completed.' : 'Failed.') : undefined}
    >
      <pre className="rounded-lg bg-muted/60 p-3 font-mono text-xs whitespace-pre-wrap">
        {result?.output.trim() || 'No output.'}
      </pre>
    </DetailDrawer>
  );
}

/**
 * Dropping an override means different things: an own server is gone
 * afterwards, a catalogue server falls back to its shipped defaults.
 */
export function RemoveToolMenuItem({ tool, onRemove }: { tool: ToolServer; onRemove(): void }) {
  if (tool.install === 'custom') {
    return (
      <DropdownMenuItem variant="destructive" onSelect={onRemove}>
        <Trash2Icon data-icon="inline-start" />
        Remove
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem onSelect={onRemove}>
      <RotateCcwIcon data-icon="inline-start" />
      Restore default
    </DropdownMenuItem>
  );
}
