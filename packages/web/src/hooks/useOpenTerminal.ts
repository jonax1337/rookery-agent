import { useCallback } from 'react';

import { useChatSession, useConnection } from '@/providers/rookery-provider';

/**
 * Opens a conversation in Claude Code's own terminal, on whatever provider,
 * model, effort, permission and project the chat composer has picked.
 *
 * Without a `sessionId` the terminal starts a conversation of its own.
 */
export function useOpenTerminal() {
  const { socket } = useConnection();
  const { turn } = useChatSession();

  return useCallback(
    (sessionId?: string) =>
      socket.openTui({
        ...(sessionId ? { sessionId } : {}),
        // Before the composer has loaded, its values are placeholders; the
        // server's saved defaults are the right answer then.
        ...(turn.ready
          ? {
              provider: turn.provider,
              ...(turn.model ? { model: turn.model } : {}),
              ...(turn.effort ? { effort: turn.effort } : {}),
              permission: turn.permission,
            }
          : {}),
        ...(turn.projectId ? { projectId: turn.projectId } : {}),
      }),
    [socket, turn],
  );
}
