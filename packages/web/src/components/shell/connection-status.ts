export type ConnectionStatus = 'online' | 'offline' | 'connecting';

/** The three words the header announcement and the sidebar foot both use. */
export const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  online: 'Connected',
  offline: 'Disconnected',
  connecting: 'Connecting …',
};

/**
 * Three states, not two: the socket needs a moment after a reload, and
 * "Connecting …" is the honest word for it. Only a failed REST call is a
 * real outage.
 */
export function connectionStatus(connected: boolean, offline: boolean): ConnectionStatus {
  if (connected) return 'online';
  return offline ? 'offline' : 'connecting';
}
