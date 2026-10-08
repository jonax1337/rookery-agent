import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldSet } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';

/*
  Always visible, below the scrolling area. Save and discard act on the whole
  draft, whichever section it was typed in - the badge says so before a
  section switch hides an edit.
*/
export function SettingsFooter({
  dirty,
  saving,
  onDiscard,
}: {
  dirty: boolean;
  saving: boolean;
  onDiscard(): void;
}) {
  return (
    <footer className="flex shrink-0 items-center gap-2 border-t px-6 py-3">
      {dirty ? (
        <Badge variant="outline" className="font-normal text-muted-foreground">
          Unsaved changes
        </Badge>
      ) : (
        <span className="text-xs text-muted-foreground">All changes saved</span>
      )}
      <div className="ml-auto flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!dirty || saving}
          onClick={onDiscard}
        >
          Discard
        </Button>
        <Button type="submit" size="sm" disabled={!dirty || saving}>
          {saving ? <Spinner aria-label="Saving" /> : null}
          Save
        </Button>
      </div>
    </footer>
  );
}

const SKELETON_FIELD_COUNT = 4;

/** Sits inside the dialog's `FieldGroup`, so it brings none of its own. */
export function SectionSkeleton() {
  return (
    <FieldSet>
      {Array.from({ length: SKELETON_FIELD_COUNT }, (_, index) => (
        <Field key={index}>
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-9 w-full" />
        </Field>
      ))}
    </FieldSet>
  );
}
