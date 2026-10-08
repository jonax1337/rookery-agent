import { useCallback, useEffect, useRef } from 'react';
import { XIcon } from '@/components/icons';

import { useConfirm } from '@/components/common/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { FieldGroup } from '@/components/ui/field';
import { SidebarProvider } from '@/components/ui/sidebar';
import { useVoiceOutput } from '@/hooks/useVoiceOutput';
import { useConfig, useSpeechState } from '@/providers/rookery-provider';
import { SectionSelect, SettingsSidebar } from './settings/SettingsNavigation';
import { SECTIONS, resolveSettingsSection, type SectionMeta } from './settings/sections';
import { SectionSkeleton, SettingsFooter } from './settings/SettingsFooter';
import { SettingsSectionBody } from './settings/SettingsSectionBody';
import { useSettingsDraft } from './settings/useSettingsDraft';
import { useTtsCatalogue } from './settings/useTtsCatalogue';

export { FIRST_SECTION_SLUG, resolveSettingsSection } from './settings/sections';

/**
 * Everything the server-side config holds, in one large dialog (sidebar-13).
 *
 * Settings used to be a page of its own. They are a dialog now because a
 * person opens them *from* somewhere - the chat, the inbox - and wants to land
 * back there, not on a settings screen that replaced what they were doing.
 * The address still says `/settings/:section`: `App` keeps the page that was
 * open behind the dialog and renders this on top, so a link from anywhere in
 * the app (or a bookmark) still opens exactly the section it names.
 *
 * The sections are grouped by what a person is looking for rather than by
 * config key: the assistant itself, the models it runs on, the company's
 * limits, the outside channels, and this browser. One-off actions (the
 * OpenClaw/Hermes import) sit last, where they do not push the everyday
 * settings down.
 *
 * What is deliberately *not* here: `memory.gate`, `memory.graph` and
 * `memory.sleep`. `PATCH /api/config` is a deep merge, so leaving them out of
 * the patch leaves them untouched - and this dialog has no honest labels for
 * numbers whose effect is only visible in the nightly run.
 */

/** The id of the form - the save button sits in the footer, outside of it. */
const FORM_ID = 'settings';

export interface SettingsDialogProps {
  /** The section in the address; unknown and legacy slugs are resolved here. */
  section: string | undefined;
  /** Move to another section (changes the address). */
  onSectionChange(slug: string): void;
  /** Leave the dialog for another route, e.g. a section that is a page. */
  onNavigate(path: string): void;
  /** Close the dialog and return to the page behind it. */
  onClose(): void;
}

export function SettingsDialog({ section, onSectionChange, onNavigate, onClose }: SettingsDialogProps) {
  const { config, providers, save } = useConfig();
  const speech = useSpeechState();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const editor = useSettingsDraft(config, save);
  const { draft, dirty, saving, discard, submit } = editor;
  const tts = useTtsCatalogue();

  // Preview speaks the *draft*, which is the whole point of a preview: trying
  // a voice out must not mean saving it first.
  const preview = useVoiceOutput(draft?.voice);

  const slug = resolveSettingsSection(section);
  const current: SectionMeta = SECTIONS.find((entry) => entry.slug === slug) ?? SECTIONS[0]!;

  // An old or unknown address is rewritten rather than shown as-is, so the
  // address bar always names the section on screen.
  useEffect(() => {
    if (section !== slug) onSectionChange(slug);
  }, [section, slug, onSectionChange]);

  // Each section starts at its top, not wherever the previous one was scrolled to.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [slug]);

  // The draft spans every section, so switching sections keeps it - only
  // leaving the dialog altogether can lose it, and that asks first.
  const leave = useCallback(
    async (then: () => void) => {
      if (dirty) {
        const ok = await confirm({
          title: 'Discard unsaved changes?',
          description: 'The changes in these settings have not been saved yet.',
          confirmLabel: 'Discard',
          destructive: true,
        });
        if (!ok) return;
        discard();
      }
      then();
    },
    [confirm, dirty, discard],
  );

  const select = (entry: SectionMeta): void => {
    if (entry.href) {
      const target = entry.href;
      void leave(() => onNavigate(target));
      return;
    }
    onSectionChange(entry.slug);
  };

  /*
    Every way out is intercepted *before* radix hears of it. The animate-ui
    Dialog flips its own open state on the first close request even while it
    is controlled, so a close that the discard question then refuses would
    leave the dialog gone and the address still on /settings.
  */
  const requestClose = (event?: Event): void => {
    event?.preventDefault();
    void leave(onClose);
  };

  return (
    <>
      <Dialog open>
        <DialogContent
          showCloseButton={false}
          onEscapeKeyDown={requestClose}
          onInteractOutside={requestClose}
          // Focus the dialog itself: radix would put it on the first nav entry,
          // whose focus ring then reads as a second selected section.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus();
          }}
          className="h-[min(760px,calc(100dvh-2rem))] gap-0 overflow-hidden p-0 sm:max-w-[calc(100%-2rem)] md:max-w-[880px] lg:max-w-[1040px]"
        >
          <DialogTitle className="sr-only">Settings</DialogTitle>
          <DialogDescription className="sr-only">
            Configure the assistant, its providers and connections.
          </DialogDescription>
          <SidebarProvider className="min-h-0 items-stretch">
            <SettingsSidebar activeSlug={current.slug} onSelect={select} />

            <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <header className="flex shrink-0 flex-col gap-3 border-b px-6 pt-5 pb-4 pr-14">
                <SectionSelect activeSlug={current.slug} onSelect={select} />
                <div className="flex flex-col gap-1">
                  <h2 className="text-lg font-semibold leading-none">{current.label}</h2>
                  <p className="text-sm text-muted-foreground">{current.description}</p>
                </div>
              </header>

              <form
                id={FORM_ID}
                noValidate
                onSubmit={(event) => void submit(event)}
                className="flex min-h-0 flex-1 flex-col"
              >
                <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
                  <FieldGroup key={current.slug} className="max-w-2xl">
                    {draft === null ? (
                      <SectionSkeleton />
                    ) : (
                      <SettingsSectionBody
                        slug={current.slug}
                        draft={draft}
                        editor={editor}
                        providers={providers}
                        tts={tts}
                        browserVoices={speech.voices}
                        preview={preview}
                      />
                    )}
                  </FieldGroup>
                </div>
                <SettingsFooter dirty={dirty} saving={saving} onDiscard={discard} />
              </form>
            </main>
          </SidebarProvider>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute top-4 right-4"
            onClick={() => requestClose()}
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </Button>
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </>
  );
}
