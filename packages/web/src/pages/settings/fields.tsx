import { useState, type ReactNode } from 'react';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldTitle,
} from '@/components/ui/field';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import { RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';

/** Stagger between the blocks of a section as they fade in. */
export const FADE_STEP_MS = 50;

/** Radix' radio groups have no empty value, so "provider default" needs one. */
export const DEFAULT_OPTION_VALUE = '__default__';

/**
 * The integer a typed text stands for, or null while it is empty, fractional,
 * not a number or outside `min`..`max`.
 */
export function parseIntegerInRange(text: string, min: number, max: number): number | null {
  if (text.trim() === '') return null;
  const number = Number(text);
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

/** A labelled on/off switch with its explanation beside it. */
export function SwitchField({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange(on: boolean): void;
}) {
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </Field>
  );
}

/** One choice of a `RadioGroup`: title and hint on the left, the radio on the right. */
export function RadioOptionField({
  id,
  value,
  title,
  hint,
  disabled,
}: {
  id: string;
  value: string;
  title: string;
  hint: ReactNode;
  disabled?: boolean;
}) {
  return (
    <FieldLabel htmlFor={id}>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle>{title}</FieldTitle>
          <FieldDescription>{hint}</FieldDescription>
        </FieldContent>
        <RadioGroupItem value={value} id={id} aria-label={title} disabled={disabled} />
      </Field>
    </FieldLabel>
  );
}

/**
 * A whole number with a hard range.
 *
 * The old page wrote `Number(event.target.value)` straight into the draft,
 * which put `NaN` in the patch the moment the field was cleared to type a new
 * value. Here the typed text lives locally until it parses inside the range;
 * only then does it reach the draft, and until then the field says why.
 */
export function NumberField({
  id,
  label,
  value,
  min,
  max,
  suffix,
  description,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  description?: string;
  onChange(value: number): void;
}) {
  const [raw, setRaw] = useState<string | null>(null);
  const shown = raw ?? String(value);
  const invalid = parseIntegerInRange(shown, min, max) === null;

  const handleChange = (next: string): void => {
    setRaw(next);
    const number = parseIntegerInRange(next, min, max);
    if (number !== null) onChange(number);
  };

  return (
    <Field data-invalid={invalid || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id={id}
          inputMode="numeric"
          value={shown}
          aria-invalid={invalid || undefined}
          onChange={(event) => handleChange(event.target.value)}
          onBlur={() => setRaw(null)}
        />
        {suffix ? (
          <InputGroupAddon align="inline-end">
            <InputGroupText>{suffix}</InputGroupText>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError>
        {invalid ? 'Enter a whole number between ' + min + ' and ' + max + '.' : null}
      </FieldError>
    </Field>
  );
}
