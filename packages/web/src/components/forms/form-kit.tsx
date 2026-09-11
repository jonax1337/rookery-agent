import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { z } from 'zod';

import { FormActions, type FormActionsProps } from '@/components/blocks/form-page';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldTitle,
} from '@/components/ui/field';
import { InputGroupButton } from '@/components/ui/input-group';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Slider } from '@/components/ui/slider';
import { failureMessage } from '@/lib/errors';

/**
 * The few things all seven form pages need and none of them should own.
 *
 * `FormPage` gives a form its frame; this gives it its behaviour: a draft
 * that a refetch cannot overwrite, `zod` issues turned into one message per
 * field, the wiring that ties a message to the field it belongs to, the
 * closed-set picker with its hints, and the header action row that
 * `usePageMeta` publishes.
 */

/* --------------------------------- draft --------------------------------- */

export interface DraftHandle<T> {
  draft: T;
  /** True once the person has touched anything. Gates "Speichern". */
  dirty: boolean;
  set(patch: Partial<T>): void;
  /**
   * Fill the draft from loaded data.
   *
   * Twice guarded, because both guards catch a different accident: `key`
   * fills once per record, so a socket-driven refetch of the same agent does
   * not reset the form, and `dirty` refuses to fill at all once something has
   * been typed - the case where the record legitimately changed under a
   * half-written edit. Call it from an effect, never during render.
   */
  hydrate(key: string | undefined, make: () => T): void;
  /** After a successful save the draft is the truth again. */
  markSaved(): void;
}

export function useDraft<T extends object>(initial: T): DraftHandle<T> {
  const [draft, setDraft] = useState<T>(initial);
  const [dirty, setDirty] = useState(false);
  // The effect below reads this synchronously, so it cannot be state.
  const dirtyRef = useRef(false);
  const filledFor = useRef<string | null>(null);

  const set = useCallback((patch: Partial<T>) => {
    dirtyRef.current = true;
    setDirty(true);
    setDraft((current) => ({ ...current, ...patch }));
  }, []);

  const hydrate = useCallback((key: string | undefined, make: () => T) => {
    if (key === undefined) return;
    if (dirtyRef.current) return;
    if (filledFor.current === key) return;
    filledFor.current = key;
    setDraft(make());
  }, []);

  const markSaved = useCallback(() => {
    dirtyRef.current = false;
    setDirty(false);
  }, []);

  return { draft, dirty, set, hydrate, markSaved };
}

/* ------------------------------- validation ------------------------------- */

/** One message per field, keyed by the first path segment of the issue. */
export type FieldErrors = Record<string, string>;

/**
 * `zod` issues flattened for hand-rendering into `FieldError`.
 *
 * The first issue per field wins: a field that is both empty and too short is
 * empty, and stacking both messages under one input reads as noise. There is
 * no collective toast any more - the message belongs where the mistake is.
 */
export function collectErrors(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '');
    if (key && !(key in errors)) errors[key] = issue.message;
  }
  return errors;
}

/* -------------------------------- submit --------------------------------- */

export interface FormSubmitHandle {
  /** One message per field, for `FormField`'s `error` prop. */
  errors: FieldErrors;
  /** The message that belongs to the whole form, for the `FormPage` banner. */
  failure: string | null;
  /** True while the request is out. Disables the save button. */
  saving: boolean;
  /** Validate, then run. Hand this to the form's `onSubmit`. */
  submit(): Promise<void>;
  /** Clears both messages without running anything. */
  reset(): void;
}

/**
 * Validate, save, complain - the seven lines every form page wrote out.
 *
 * All seven kept the same three states (`errors`, `failure`, `saving`) and the
 * same skeleton around the one call that differed: `safeParse` -> collect the
 * issues and stop -> clear both messages -> set saving -> try the call -> catch
 * into `failure` -> clear saving. The project form and the team form were
 * character-identical apart from two words and the route they navigated to.
 *
 * `run` gets the parsed draft and keeps what is genuinely the page's: the api
 * call, `markSaved()`, the toast and the navigation. Anything it throws lands
 * in `failure` - so a failed save never navigates away from the typed text.
 *
 * ```tsx
 * const { errors, failure, saving, submit } = useFormSubmit(schema, draft, async (parsed) => {
 *   await api.updateProject(id, parsed);
 *   markSaved();
 *   toast('Projekt gespeichert');
 *   void navigate('/org/projects');
 * });
 * ```
 */
export function useFormSubmit<T>(
  schema: z.ZodType<T>,
  draft: unknown,
  run: (parsed: T) => Promise<void>,
): FormSubmitHandle {
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // `run` is written inline at every call site and closes over the draft, so
  // it changes identity on every keystroke. The ref keeps `submit` stable
  // without forcing the pages to wrap their handler in `useCallback`.
  const runRef = useRef(run);
  runRef.current = run;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const schemaRef = useRef(schema);
  schemaRef.current = schema;

  const reset = useCallback(() => {
    setErrors({});
    setFailure(null);
  }, []);

  const submit = useCallback(async (): Promise<void> => {
    const parsed = schemaRef.current.safeParse(draftRef.current);
    if (!parsed.success) {
      setErrors(collectErrors(parsed.error));
      return;
    }
    setErrors({});
    setFailure(null);
    setSaving(true);
    try {
      await runRef.current(parsed.data);
    } catch (caught) {
      setFailure(failureMessage(caught));
    } finally {
      setSaving(false);
    }
  }, []);

  return { errors, failure, saving, submit, reset };
}

/* ------------------------------- field aria ------------------------------- */

/** The four pieces of one field's wiring, sorted by where they belong. */
export interface FieldAria {
  /** Onto the `Field` - `fieldVariants` paints the whole group red from it. */
  field: { 'data-invalid': true | undefined };
  /** `htmlFor` of the `FieldLabel`, and the `id` of the control. */
  id: string;
  /** Spread onto the control: `Input`, `Textarea`, `InputGroupInput`, a combobox. */
  control: {
    id: string;
    'aria-invalid': true | undefined;
    'aria-describedby': string | undefined;
  };
  /** Onto the `FieldDescription`, when the field has one. */
  description: { id: string };
  /** Onto the `FieldError`. */
  error: { id: string };
}

/**
 * Ties a field's message to the field itself.
 *
 * `FieldError` carries `role="alert"`, so a message that appears is read out
 * once - but a person who tabs back to the rejected input afterwards hears
 * only its name. `aria-describedby` is what makes the message part of the
 * field, and the hint under it part of the field as well.
 *
 * Both ids are derived from the field id rather than generated, so the caller
 * never has to keep a second identifier around. Pass a `useId()`-based prefix
 * to keep two forms on one page apart.
 */
export function fieldAria(
  id: string,
  error?: string | null | undefined,
  options?: { described?: boolean },
): FieldAria {
  const invalid = Boolean(error);
  const errorId = id + '-fehler';
  const descriptionId = id + '-hinweis';
  const described = [options?.described ? descriptionId : null, invalid ? errorId : null]
    .filter((value): value is string => value !== null)
    .join(' ');

  return {
    field: { 'data-invalid': invalid || undefined },
    id,
    control: {
      id,
      'aria-invalid': invalid || undefined,
      'aria-describedby': described || undefined,
    },
    description: { id: descriptionId },
    error: { id: errorId },
  };
}

export interface FormFieldProps {
  /** Unique on the page; the message and hint ids are derived from it. */
  id: string;
  label: ReactNode;
  /** The line under the control. */
  description?: ReactNode;
  /** One message from `collectErrors`; `undefined` means the field is fine. */
  error?: string | null | undefined;
  orientation?: 'vertical' | 'horizontal' | 'responsive';
  className?: string;
  /** Gets the props the control has to carry - spread them, do not rebuild them. */
  children: (control: FieldAria['control']) => ReactNode;
}

/**
 * Label, control, hint and message as one field, wired together.
 *
 * The control stays the page's business - these forms use `Input`, `Textarea`,
 * `InputGroup` and two comboboxes - so it arrives as a function that gets the
 * id and the ARIA attributes it has to wear.
 */
export function FormField({
  id,
  label,
  description,
  error,
  orientation,
  className,
  children,
}: FormFieldProps) {
  const aria = fieldAria(id, error, { described: description !== undefined });

  return (
    <Field
      {...(orientation ? { orientation } : {})}
      {...(className ? { className } : {})}
      {...aria.field}
    >
      <FieldLabel htmlFor={aria.id}>{label}</FieldLabel>
      {children(aria.control)}
      {description !== undefined ? (
        <FieldDescription {...aria.description}>{description}</FieldDescription>
      ) : null}
      {error ? <FieldError {...aria.error}>{error}</FieldError> : null}
    </Field>
  );
}

/* --------------------------------- choice --------------------------------- */

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  /** One line under the label - `PERMISSION_HINT`, `AUDIENCE_HINT`, … */
  description?: string;
  /** A provider mark or a glyph in front of the label. */
  icon?: ReactNode;
  disabled?: boolean;
}

export interface ChoiceFieldProps<T extends string> {
  /** Prefix for the generated option ids; make it unique per page. */
  id: string;
  options: readonly ChoiceOption<T>[];
  value: T;
  onChange(value: T): void;
  disabled?: boolean;
  invalid?: boolean;
  /** The `FieldError`'s id - `fieldAria(...).error.id` at the call site. */
  describedBy?: string;
  className?: string;
}

/**
 * A radio group drawn as labelled cards.
 *
 * Five of the seven forms pick from a small closed set - Zugriff, Anbieter,
 * Priorität, Für wen, Wer führt aus - and every one of them deserves the hint
 * that already exists next to its label map (`PERMISSION_HINT`,
 * `AUDIENCE_HINT`, …). A `Select` hides those hints behind a click, so the
 * choice is made blind; these cards show them.
 *
 * The markup is the registry's own radio-in-`FieldLabel` pattern, written
 * once here instead of five times in the pages.
 */
export function ChoiceField<T extends string>({
  id,
  options,
  value,
  onChange,
  disabled = false,
  invalid = false,
  describedBy,
  className,
}: ChoiceFieldProps<T>) {
  return (
    <RadioGroup
      value={value}
      onValueChange={(next) => onChange(next as T)}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      className={className}
    >
      {options.map((option) => {
        const optionId = id + '-' + option.value;
        return (
          <FieldLabel key={option.value} htmlFor={optionId}>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle>
                  {option.icon}
                  {option.label}
                </FieldTitle>
                {option.description ? (
                  <FieldDescription>{option.description}</FieldDescription>
                ) : null}
              </FieldContent>
              <RadioGroupItem
                id={optionId}
                value={option.value}
                disabled={option.disabled ?? false}
              />
            </Field>
          </FieldLabel>
        );
      })}
    </RadioGroup>
  );
}

/* -------------------------------- actions -------------------------------- */

export interface FormMenuAction {
  label: string;
  icon?: LucideIcon;
  onSelect(): void;
  /** Paints it red. Every deletion sets it, and asks with `useConfirm` first. */
  destructive?: boolean;
  disabled?: boolean;
}

export interface FormHeaderActionsProps extends Omit<FormActionsProps, 'destructive'> {
  /** Archivieren, auflösen, löschen - apart from the save group on purpose. */
  menu?: readonly FormMenuAction[];
}

/**
 * What a form page hands to `usePageMeta`: the destructive actions folded
 * into a menu, then [Abbrechen | Speichern].
 *
 * The template's own `destructive` prop puts a red button next to the save
 * button, which is right at the foot of a form but wrong in a header strip
 * three centimetres from "Speichern" - hence the menu.
 */
export function FormHeaderActions({ menu = [], ...actions }: FormHeaderActionsProps) {
  return (
    <div className="flex items-center gap-2">
      {menu.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* The header overflow of a form is the same gesture as the one on
                a detail page, so it wears the same trigger. */}
            <RowMenuButton type="button" tone="header" label="Weitere Aktionen" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {menu.map((action) => (
              <DropdownMenuItem
                key={action.label}
                variant={action.destructive ? 'destructive' : 'default'}
                disabled={action.disabled ?? false}
                onSelect={action.onSelect}
              >
                {action.icon ? <action.icon /> : null}
                {action.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <FormActions {...actions} />
    </div>
  );
}

/* -------------------------------- skeleton -------------------------------- */

/**
 * Placeholder fields while the record is still loading.
 *
 * Not cosmetic: an empty input on a page that has not loaded yet is a form
 * that will happily PATCH the record to blank. The skeleton has no inputs to
 * submit, so it cannot.
 */
export function FormFieldsSkeleton({ fields = 4 }: { fields?: number }) {
  return (
    <FieldGroup>
      <FieldSet>
        {Array.from({ length: fields }, (_, index) => (
          <Field key={index}>
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-9 w-full" />
          </Field>
        ))}
      </FieldSet>
    </FieldGroup>
  );
}

/* --------------------------------- slider --------------------------------- */

export interface SliderFieldProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** What "Zurücksetzen" restores. */
  fallback: number;
  /** The value as the reader sees it next to the label: "1,00×", "12 %". */
  format(value: number): string;
  /** The line under the slider. Left out on the sheet, where space is tight. */
  description?: ReactNode;
  onChange(value: number): void;
  /**
   * Fires once the handle is let go. The voice sheet saves on commit rather
   * than on every step, so a drag does not send twenty PATCHes.
   */
  onCommit?(value: number): void;
}

/**
 * A slider with its value spelled out and a way back to the default.
 *
 * The settings page called it `SliderField` and the voice sheet `SheetSlider`,
 * and the comment above the second one said outright that it was the first one
 * again. They were identical but for `onCommit`, which is now a prop.
 *
 * The badge is what makes the control readable: a bare track says "somewhere
 * between slow and fast", the badge says "1,08×".
 */
export function SliderField({
  id,
  label,
  value,
  min,
  max,
  step,
  fallback,
  format,
  description,
  onChange,
  onCommit,
}: SliderFieldProps) {
  return (
    <Field>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <div className="flex items-center gap-1">
          <Badge variant="secondary" className="tabular-nums">
            {format(value)}
          </Badge>
          <InputGroupButton
            disabled={value === fallback}
            onClick={() => {
              onChange(fallback);
              onCommit?.(fallback);
            }}
          >
            Zurücksetzen
          </InputGroupButton>
        </div>
      </div>
      <Slider
        id={id}
        min={min}
        max={max}
        step={step}
        value={[value]}
        aria-label={label}
        onValueChange={([next]) => onChange(next ?? fallback)}
        {...(onCommit ? { onValueCommit: ([next]: number[]) => onCommit(next ?? fallback) } : {})}
      />
      {description !== undefined ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}
