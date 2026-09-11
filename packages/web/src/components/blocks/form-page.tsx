import type { FormEvent, ReactNode } from 'react';
import { useId } from 'react';
import { useNavigate } from 'react-router';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldGroup } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

/**
 * The frame every form page sits in: one `Card` holding a `FieldGroup` of
 * `FieldSet`s, and one action bar.
 *
 * There is deliberately no `@/components/ui/form` here - that file does not
 * exist in the radix-vega registry. Validation is `zod` in the page, and the
 * messages are rendered by hand into `FieldError`; this template only gives
 * them a place to stand.
 *
 * The action bar is [Abbrechen] [Speichern] on the right - two buttons with a
 * gap, never a `ButtonGroup`: that welds its children into one control, and an
 * outlined button fused to a filled one reads as a segmented switch missing a
 * border. A destructive action (löschen, archivieren, auflösen) sits apart on
 * the left, never beside those two and never in the field flow, so a mis-aimed
 * click cannot delete what the page was about to save.
 */

export interface FormDestructiveAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export interface FormActionsProps {
  /** Submits the form with this id - needed when the bar sits in the header. */
  form?: string;
  submitLabel?: string;
  cancelLabel?: string;
  /** Runs instead of navigating; without it, `cancelTo` decides. */
  onCancel?: () => void;
  /** Where "Abbrechen" goes. Always an explicit route, never `navigate(-1)`. */
  cancelTo?: string;
  submitting?: boolean;
  /** Usually `!dirty || submitting` - the page owns that judgement. */
  submitDisabled?: boolean;
  destructive?: FormDestructiveAction;
  className?: string;
}

/**
 * The bar on its own, for pages that hand their actions to `usePageMeta`
 * instead of leaving them at the foot of the form. Pass the same `formId`
 * there that `FormPage` got, or the submit button will have no form to
 * submit.
 */
export function FormActions({
  form,
  submitLabel = 'Speichern',
  cancelLabel = 'Abbrechen',
  onCancel,
  cancelTo,
  submitting = false,
  submitDisabled = false,
  destructive,
  className,
}: FormActionsProps) {
  const navigate = useNavigate();

  const cancel = () => {
    if (onCancel) {
      onCancel();
      return;
    }
    if (cancelTo) void navigate(cancelTo);
  };

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {destructive ? (
        <Button
          type="button"
          variant="ghost"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={destructive.disabled ?? false}
          onClick={destructive.onClick}
        >
          {destructive.label}
        </Button>
      ) : null}
      {/*
        Two separate buttons with a gap, not a `ButtonGroup`: the group welds
        its children into one control, and an outlined "Abbrechen" fused to a
        filled "Speichern" looks like a segmented switch that lost a border.
      */}
      <div className="ml-auto flex items-center gap-2">
        <Button type="button" variant="outline" onClick={cancel}>
          {cancelLabel}
        </Button>
        <Button type="submit" form={form} disabled={submitDisabled || submitting}>
          {submitting ? <Spinner aria-label="Wird gespeichert" /> : null}
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

export interface FormPageProps extends Omit<FormActionsProps, 'form' | 'className'> {
  /** Card heading. Left out when the breadcrumb already says it. */
  title?: ReactNode;
  description?: ReactNode;
  /** The `FieldSet`s, separated by `FieldSeparator`. */
  children: ReactNode;
  onSubmit: () => void | Promise<void>;
  /** A whole-form failure (the request came back 409, say), above the bar. */
  error?: string | null;
  /** Cards that belong to the form but not into the field flow, e.g. a preview. */
  aside?: ReactNode;
  /** Set when the bar is rendered elsewhere - the page keeps the same id. */
  formId?: string;
  /** Off when `usePageMeta` already shows the actions in the header. */
  showActions?: boolean;
  className?: string;
}

export function FormPage({
  title,
  description,
  children,
  onSubmit,
  error,
  aside,
  formId,
  showActions = true,
  className,
  ...actions
}: FormPageProps) {
  const fallbackId = useId();
  const id = formId ?? fallbackId;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSubmit();
  };

  return (
    <form
      id={id}
      noValidate
      onSubmit={handleSubmit}
      className={cn('flex flex-col gap-4 md:gap-6', className)}
    >
      <Card>
        {title !== undefined || description !== undefined ? (
          <CardHeader>
            {title !== undefined ? <CardTitle>{title}</CardTitle> : null}
            {description !== undefined ? <CardDescription>{description}</CardDescription> : null}
          </CardHeader>
        ) : null}
        <CardContent>
          <FieldGroup>{children}</FieldGroup>
        </CardContent>
      </Card>
      {aside}
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Nicht gespeichert</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {showActions ? <FormActions form={id} {...actions} /> : null}
    </form>
  );
}
