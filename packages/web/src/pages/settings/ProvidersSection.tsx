import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import type { ProviderStatus, PublicConfig } from '@/lib/types';
import { DefaultProviderSection } from './DefaultProviderSection';
import { FADE_STEP_MS } from './fields';
import { ProviderFallbackSection } from './ProviderFallbackSection';
import { ProviderProfilesSection } from './ProviderProfilesSection';

export function ProvidersSection({
  draft,
  providers,
  set,
}: {
  draft: PublicConfig;
  providers: readonly ProviderStatus[];
  set(patch: Partial<PublicConfig>): void;
}) {
  return (
    <>
      <DefaultProviderSection draft={draft} providers={providers} set={set} />
      <Fade delay={2 * FADE_STEP_MS}>
        <ProviderFallbackSection draft={draft} providers={providers} set={set} />
      </Fade>
      <Fade delay={3 * FADE_STEP_MS}>
        <ProviderProfilesSection providers={providers} />
      </Fade>
    </>
  );
}
