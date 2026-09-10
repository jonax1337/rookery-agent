import { useEffect, useMemo, useState } from 'react';
import { socketUrl } from '../lib/api';
import { RookerySocket, type SocketStatus } from '../lib/socket';
import type { MemoryRecord } from '../lib/types';

/** Owns the single app-wide socket and mirrors its status into React state. */
export function useSocket() {
  const socket = useMemo(() => new RookerySocket(socketUrl()), []);
  const [status, setStatus] = useState<SocketStatus>('closed');

  useEffect(() => {
    const unsubscribe = socket.onStatus(setStatus);
    socket.connect();
    return () => {
      unsubscribe();
      socket.close();
    };
  }, [socket]);

  return { socket, status, connected: status === 'open' };
}

/** Subscribe to memories learned in the background after a turn. */
export function useLearnedMemories(
  socket: RookerySocket,
  onLearned: (stored: MemoryRecord[]) => void,
): void {
  useEffect(() => {
    return socket.onMemory((event) => {
      if (event.stored.length) onLearned(event.stored);
    });
  }, [socket, onLearned]);
}
