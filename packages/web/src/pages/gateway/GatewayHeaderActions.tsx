import { SendIcon } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

/** Ties the header's Save button to the form rendered in the page body. */
export const GATEWAY_FORM_ID = 'gateway-telegram';

export function GatewayHeaderActions({
  dirty,
  saving,
  testing,
  onTest,
  onDiscard,
}: {
  dirty: boolean;
  saving: boolean;
  testing: boolean;
  onTest(): void;
  onDiscard(): void;
}) {
  return (
    <div className="flex items-center gap-2">
      {dirty ? (
        <Badge variant="outline" className="hidden font-normal text-muted-foreground sm:inline-flex">
          Unsaved changes
        </Badge>
      ) : null}
      <Button type="button" variant="outline" size="sm" disabled={testing} onClick={onTest}>
        {testing ? <Spinner aria-label="Sending" /> : <SendIcon data-icon="inline-start" size={24} />}
        Send test message
      </Button>
      <Button type="button" variant="ghost" size="sm" disabled={!dirty || saving} onClick={onDiscard}>
        Discard
      </Button>
      <Button type="submit" form={GATEWAY_FORM_ID} size="sm" disabled={!dirty || saving}>
        {saving ? <Spinner aria-label="Saving" /> : null}
        Save
      </Button>
    </div>
  );
}
