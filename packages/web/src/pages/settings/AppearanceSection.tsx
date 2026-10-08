import { ThemeTogglerButton } from '@/components/animate-ui/components/buttons/theme-toggler';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { FieldDescription, FieldLegend, FieldSet } from '@/components/ui/field';

const LOCAL_HINT = 'Applies immediately and is saved in this browser only.';

/**
 * Appearance preferences never reach the server.
 *
 * They sit in their own section instead of hanging below the tabs, because
 * the two storage models are genuinely different: everything else on this
 * page needs "Save" and then applies everywhere, these apply at once and
 * only here. The theme choice is the same one the sidebar footer offers; the
 * toggler cycles light, dark and system, and the icon says where the cycle
 * stands.
 */
export function AppearanceSection() {
  return (
    <Fade>
      <FieldSet>
        <FieldLegend variant="label">Theme</FieldLegend>
        <FieldDescription>{LOCAL_HINT}</FieldDescription>
        {/*
          Policy B9: the three-way radio gave way to a ThemeTogglerButton that
          cycles light - dark - system and plays the change as a wipe across
          the surface. Styled like our outline button (muted instead of
          accent on hover).
        */}
        <ThemeTogglerButton
          variant="outline"
          aria-label="Change theme"
          className="hover:bg-muted hover:text-foreground"
        />
      </FieldSet>
    </Fade>
  );
}
