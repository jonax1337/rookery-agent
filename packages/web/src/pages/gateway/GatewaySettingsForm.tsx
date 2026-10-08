import { FormPage } from '@/components/blocks/form-page';
import { FormFieldsSkeleton } from '@/components/forms/form-kit';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { GatewayDraft } from '@/hooks/useGatewayDraft';
import type { GatewayStatus } from '@/lib/types';
import { AllowedIdsSection } from './AllowedIdsSection';
import { FilesAndSpeechSection } from './FilesAndSpeechSection';
import {
  BotTokenField,
  ChatSection,
  EnabledField,
  ModelField,
  PermissionSection,
} from './GatewayGeneralFields';
import { GATEWAY_FORM_ID } from './GatewayHeaderActions';
import { PushSection } from './PushSection';

export function GatewaySettingsForm({
  gateway,
  form,
}: {
  gateway: GatewayStatus;
  form: GatewayDraft;
}) {
  const { draft, set } = form;

  if (draft === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <FormFieldsSkeleton fields={5} />
        </CardContent>
      </Card>
    );
  }

  return (
    <FormPage
      formId={GATEWAY_FORM_ID}
      showActions={false}
      onSubmit={form.submit}
      title="Settings"
      description="Save to apply changes immediately."
    >
      <EnabledField draft={draft} set={set} />
      <BotTokenField gateway={gateway} draft={draft} set={set} />
      <PermissionSection draft={draft} set={set} />
      <ModelField draft={draft} set={set} />
      <ChatSection draft={draft} set={set} />
      <FilesAndSpeechSection draft={draft} set={set} />
      <AllowedIdsSection
        draft={draft}
        onAdd={form.addAllowedId}
        onRemove={form.removeAllowedId}
        onPairingChange={(on) => set({ pairing: on })}
      />
      <PushSection
        draft={draft}
        setPush={form.setPush}
        onToggleRecipient={form.toggleRecipient}
      />
    </FormPage>
  );
}
