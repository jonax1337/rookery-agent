import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { reportFailure } from '@/lib/errors';
import type { GatewayId, GatewayTestResult } from '@/lib/types';

export interface GatewayTestMessage {
  testing: boolean;
  runTest(): Promise<void>;
}

/** Sends a test push through the Telegram gateway and reports the outcome. */
export function useGatewayTestMessage(
  test: (id: GatewayId) => Promise<GatewayTestResult>,
): GatewayTestMessage {
  const [testing, setTesting] = useState(false);

  const runTest = useCallback(async (): Promise<void> => {
    setTesting(true);
    try {
      // A channel that cannot send (not running, no recipient) answers 400,
      // which surfaces here as a thrown `ApiError` - there is no `ok: false`.
      const result = await test('telegram');
      toast('Test message sent', { description: 'Sent to ' + result.recipient + '.' });
    } catch (caught) {
      reportFailure('Test message', caught);
    } finally {
      setTesting(false);
    }
  }, [test]);

  return { testing, runTest };
}
