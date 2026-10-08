import type { ComponentProps } from 'react';

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';

export interface Option {
  value: string;
  label: string;
}

type InputAttributes = Omit<
  ComponentProps<typeof ComboboxInput>,
  'value' | 'onChange' | 'placeholder' | 'showClear'
>;

/**
 * The plain single-select combobox shared by the agent filter and the assign
 * drawer's fields.
 *
 * The remaining props go straight to the input - that is where the focus sits,
 * so that is where `FormField`'s ARIA attributes have to land to say the field
 * was rejected and where the reason is written.
 */
export function OptionCombobox({
  options,
  value,
  onChange,
  placeholder,
  emptyText = 'Nothing found',
  ...inputAttributes
}: InputAttributes & {
  options: Option[];
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder: string;
  emptyText?: string;
}) {
  const selected = options.find((option) => option.value === value) ?? null;

  return (
    <Combobox
      items={options}
      value={selected}
      onValueChange={(next: Option | null) => onChange(next?.value ?? null)}
    >
      <ComboboxInput
        {...inputAttributes}
        placeholder={placeholder}
        showClear={selected !== null}
      />
      <ComboboxContent>
        <ComboboxEmpty>{emptyText}</ComboboxEmpty>
        <ComboboxList>
          {(item: Option) => (
            <ComboboxItem key={item.value} value={item}>
              {item.label}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
