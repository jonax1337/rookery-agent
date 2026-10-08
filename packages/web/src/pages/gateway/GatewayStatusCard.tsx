import { MetaList } from '@/components/common/meta-list';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime } from '@/lib/stats';
import type { GatewayStatus } from '@/lib/types';

/** Where the running channel got its token, in words. */
const TOKEN_SOURCE_LABEL: Record<GatewayStatus['tokenSource'], string> = {
  config: 'Saved here',
  env: 'Environment variable TELEGRAM_BOT_TOKEN',
  none: 'None yet',
};

export function GatewayStatusCard({ gateway }: { gateway: GatewayStatus }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Status</CardTitle>
        <CardDescription>
          Save the bot token below to apply it without restarting. It is stored in <code>~/.rookery/config.json</code>, but is never returned to this page. It only reports <em>whether</em> a token is set. Create a bot with{' '}
          <Button asChild variant="link" className="h-auto gap-0 p-0 text-left align-baseline">
            <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">
              @BotFather
            </a>
          </Button>
          .
        </CardDescription>
      </CardHeader>
      <CardContent>
        <MetaList
          columns={2}
          items={[
            { label: 'Token configured', value: gateway.configured ? 'Yes' : 'No' },
            { label: 'Source', value: TOKEN_SOURCE_LABEL[gateway.tokenSource] },
            { label: 'Running', value: gateway.running ? 'Yes' : 'No' },
            { label: 'Bot name', value: gateway.botUsername ? '@' + gateway.botUsername : '' },
            { label: 'Last error', value: gateway.lastError },
            {
              label: 'Last event',
              value: gateway.lastEventAt ? formatDateTime(gateway.lastEventAt) : '',
            },
          ]}
        />
      </CardContent>
    </Card>
  );
}
