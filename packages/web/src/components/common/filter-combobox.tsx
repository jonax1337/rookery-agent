import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';

/**
 * One toolbar filter: a one-of-many picker with a search field.
 *
 * A combobox rather than a select because these lists grow with the company -
 * a twenty-entry select is a scroll hunt. Three pages wrote the same wrapper
 * around the primitive (the conversation list even left a note saying it
 * should move here as soon as a second page wanted it), so this is that move.
 *
 * Two shapes of filter live in the app and both fit here:
 *
 * - *clearable* - `null` means "no filter" and the × in the field is how one
 *   says it. That is the default.
 * - *always one* - the options carry their own "Alle …" entry, so there is
 *   nothing to clear. Those call sites pass `showClear={false}` and never see
 *   a `null` come back, because one option always matches.
 */

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterComboboxProps {
  /** Set it when a `FieldLabel` points at the input with `htmlFor`. */
  id?: string;
  /** The accessible name. Also the placeholder, unless one is given. */
  label: string;
  placeholder?: string;
  options: readonly FilterOption[];
  /** The selected option's value, or `null` for "nothing picked". */
  value: string | null;
  onChange(value: string | null): void;
  /** Off where the options include their own "Alle …" entry. */
  showClear?: boolean;
  className?: string;
}

export function FilterCombobox({
  id,
  label,
  placeholder,
  options,
  value,
  onChange,
  showClear = true,
  className,
}: FilterComboboxProps) {
  const selected = options.find((option) => option.value === value) ?? null;

  return (
    <Combobox<FilterOption>
      items={options as FilterOption[]}
      value={selected}
      onValueChange={(next) => onChange(next ? next.value : null)}
      isItemEqualToValue={(a, b) => a.value === b.value}
    >
      <ComboboxInput
        {...(id ? { id } : {})}
        aria-label={label}
        placeholder={placeholder ?? label}
        className={className ?? 'h-8 w-full sm:w-44'}
        showClear={showClear}
      />
      <ComboboxContent>
        <ComboboxEmpty>Nichts gefunden</ComboboxEmpty>
        <ComboboxList>
          {(option: FilterOption) => (
            <ComboboxItem key={option.value} value={option}>
              {option.label}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
