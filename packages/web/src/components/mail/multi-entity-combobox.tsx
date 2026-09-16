import { RemovableChip } from '@/components/common/removable-chip';
import { EntityCombobox, type EntityOption } from '@/components/forms/entity-combobox';

/**
 * A multi-value wrapper around `EntityCombobox`: a row of removable chips for
 * what is already picked, plus the single-select combobox underneath to add
 * more. There is no multi-select combobox in the tree, and compose's To/Cc
 * are the only fields in the app that need one.
 */

interface MultiEntityComboboxProps {
  options: readonly EntityOption[];
  value: readonly EntityOption[];
  onChange(value: EntityOption[]): void;
  placeholder?: string;
  emptyLabel?: string;
}

export function MultiEntityCombobox({
  options,
  value,
  onChange,
  placeholder,
  emptyLabel,
}: MultiEntityComboboxProps) {
  // Already-chosen entries drop out of the combobox's own list, the way a
  // real To field stops offering someone already on it.
  const available = options.filter((option) => !value.some((chosen) => chosen.value === option.value));

  const remove = (target: string): void => onChange(value.filter((chosen) => chosen.value !== target));

  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((chosen) => (
            <RemovableChip
              key={chosen.value}
              label={chosen.label}
              onRemove={() => remove(chosen.value)}
            />
          ))}
        </div>
      )}
      <EntityCombobox
        options={available}
        value={null}
        onChange={(next) => {
          const selected = available.find((option) => option.value === next);
          if (selected) onChange([...value, selected]);
        }}
        placeholder={placeholder}
        {...(emptyLabel ? { emptyLabel } : {})}
        clearable={false}
      />
    </div>
  );
}
