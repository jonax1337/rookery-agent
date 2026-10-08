import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { AppUpdates } from '@/components/forms/app-updates';
import { AssistantMigration } from '@/components/forms/assistant-migration';
import type { VoiceOutput } from '@/hooks/useVoiceOutput';
import type { ProviderStatus, PublicConfig } from '@/lib/types';
import { AppearanceSection } from './AppearanceSection';
import { BehaviorSection } from './BehaviorSection';
import { MailboxesSection } from './MailboxesSection';
import { MemorySection } from './MemorySection';
import { OrgSection } from './OrgSection';
import { ProfileSection } from './ProfileSection';
import { ProvidersSection } from './ProvidersSection';
import { DEFAULT_UPDATES, type SettingsDraft } from './useSettingsDraft';
import type { TtsCatalogueState } from './useTtsCatalogue';
import { VoiceSection } from './VoiceSection';

interface SettingsSectionBodyProps {
  /** A slug `resolveSettingsSection` returned, never a legacy or unknown one. */
  slug: string;
  draft: PublicConfig;
  editor: SettingsDraft;
  providers: readonly ProviderStatus[];
  tts: TtsCatalogueState;
  browserVoices: SpeechSynthesisVoice[];
  preview: VoiceOutput;
}

/** The form fields of one settings section. */
export function SettingsSectionBody({
  slug,
  draft,
  editor,
  providers,
  tts,
  browserVoices,
  preview,
}: SettingsSectionBodyProps) {
  switch (slug) {
    case 'profile':
      return <ProfileSection draft={draft} set={editor.set} />;
    case 'behavior':
      return <BehaviorSection draft={draft} set={editor.set} />;
    case 'voice':
      return (
        <VoiceSection
          voice={draft.voice}
          catalogue={tts.catalogue}
          failed={tts.failed}
          onRetry={() => void tts.reload()}
          browserVoices={browserVoices}
          setVoice={editor.setVoice}
          preview={preview}
        />
      );
    case 'memory':
      return <MemorySection draft={draft} setMemory={editor.setMemory} />;
    case 'providers':
      return <ProvidersSection draft={draft} providers={providers} set={editor.set} />;
    case 'org':
      return <OrgSection draft={draft} setOrg={editor.setOrg} />;
    case 'mailboxes':
      return <MailboxesSection draft={draft} setListeners={editor.setListeners} />;
    case 'appearance':
      return <AppearanceSection />;
    case 'updates':
      return (
        <Fade>
          <AppUpdates settings={draft.updates ?? DEFAULT_UPDATES} onChange={editor.setUpdates} />
        </Fade>
      );
    case 'import':
      return (
        <Fade>
          <AssistantMigration />
        </Fade>
      );
    default:
      return null;
  }
}
