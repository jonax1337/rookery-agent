import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';
import { cn } from '@/lib/utils';

/**
 * One picker for "which agent / which team / which project".
 *
 * Every form in this app had the same select, and every one of them carried a
 * `'__none__'` sentinel because Radix' `Select` refuses an empty value. The
 * combobox does not: `null` is a real value here, so "Noch offen" is an
 * absent id rather than a magic string that a `save()` has to translate back.
 * It also filters as you type, which the company's agent list needs long
 * before a person would want to scroll it.
 *
 * Deliberately not in `components/common/`: it is a field, not a page block,
 * and it is shared by exactly the seven form pages.
 */

export interface EntityOption {
  /** The id that goes to the API. Never a sentinel. */
  value: string;
  label: string;
  /** Right-aligned second fact, e.g. an agent's title. */
  hint?: string;
}

export interface EntityComboboxProps {
  id?: string;
  options: readonly EntityOption[];
  /** `null` means nothing is chosen - and that is a value the API accepts. */
  value: string | null;
  onChange(value: string | null): void;
  /** What the empty field says: "Kein Projekt", "Noch offen", "Ohne Team". */
  placeholder?: string;
  /** Shown when the typed query matches nothing. */
  emptyLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
  /** Off for a field that must stay filled once it is. */
  clearable?: boolean;
  className?: string;
}

export function EntityCombobox({
  id,
  options,
  value,
  onChange,
  placeholder,
  emptyLabel = 'Nothing found',
  disabled = false,
  invalid = false,
  clearable = true,
  className,
}: EntityComboboxProps) {
  // The selected option object, not the id: Base UI keeps the whole item as
  // its value so it can print the label without a second lookup.
  const selected = options.find((option) => option.value === value) ?? null;

  return (
    <Combobox
      items={options}
      value={selected}
      onValueChange={(next) => onChange(next ? next.value : null)}
      isItemEqualToValue={(a, b) => a.value === b.value}
      itemToStringLabel={(item) => item.label}
      disabled={disabled}
    >
      <ComboboxInput
        id={id}
        placeholder={placeholder ?? ''}
        disabled={disabled}
        showClear={clearable && selected !== null}
        aria-invalid={invalid || undefined}
        className={cn('w-full', className)}
      />
      <ComboboxContent>
        <ComboboxEmpty>{emptyLabel}</ComboboxEmpty>
        <ComboboxList>
          {(item: EntityOption) => (
            <ComboboxItem key={item.value} value={item}>
              <span className="truncate">{item.label}</span>
              {item.hint ? (
                <span className="ml-auto truncate text-xs text-muted-foreground">{item.hint}</span>
              ) : null}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
