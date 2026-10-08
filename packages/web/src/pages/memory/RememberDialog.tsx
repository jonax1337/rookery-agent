import { useCallback, useId, useState } from 'react';

import { toast } from 'sonner';
import { z } from 'zod';

import { MEMORY_KIND_LABEL, MEMORY_KINDS } from '@/lib/format';
import { formatPercent } from '@/lib/stats';
import type { MemoryKind } from '@/lib/types';
import { collectErrors, type FieldErrors } from '@/components/forms/form-kit';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Slider } from '@/components/ui/slider';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';

const DEFAULT_KIND: MemoryKind = 'fact';

/** What a hand-written memory weighs until its author moves the slider. */
const DEFAULT_IMPORTANCE = 0.7;

const rememberSchema = z.object({
  content: z.string().trim().min(3, 'One sentence is enough, but it cannot be empty.'),
  kind: z.enum(['fact', 'preference', 'project', 'event', 'summary', 'insight']),
  tags: z.string(),
  importance: z.number().min(0).max(1),
});

interface RememberDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  onAdd(input: {
    content: string;
    kind?: MemoryKind;
    tags?: string[];
    importance?: number;
  }): Promise<boolean>;
}

function parseTags(raw: string): string[] {
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/**
 * Saving a memory by hand, as a dialog rather than a permanent form.
 *
 * It is the only way into the bank by hand, and what it writes carries
 * `origin: 'user'` on the server - which is what protects it from the night.
 * That is worth a sentence in the dialog, because it is the difference
 * between a note and a note that survives.
 */
export function RememberDialog({ open, onOpenChange, onAdd }: RememberDialogProps) {
  const formId = useId();
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<MemoryKind>(DEFAULT_KIND);
  const [tags, setTags] = useState('');
  const [importance, setImportance] = useState(DEFAULT_IMPORTANCE);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);

  const reset = useCallback(() => {
    setContent('');
    setKind(DEFAULT_KIND);
    setTags('');
    setImportance(DEFAULT_IMPORTANCE);
    setErrors({});
  }, []);

  const submit = useCallback(async (): Promise<void> => {
    const parsed = rememberSchema.safeParse({ content, kind, tags, importance });
    if (!parsed.success) {
      setErrors(collectErrors(parsed.error));
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const topics = parseTags(parsed.data.tags);
      const ok = await onAdd({
        content: parsed.data.content,
        kind: parsed.data.kind,
        importance: parsed.data.importance,
        ...(topics.length ? { tags: topics } : {}),
      });
      if (!ok) {
        toast.error('Not saved', { description: 'The server did not accept the memory.' });
        return;
      }
      toast('Remembered', { description: parsed.data.content });
      reset();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }, [content, importance, kind, onAdd, onOpenChange, reset, tags]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Save a memory</DialogTitle>
          <DialogDescription>
            Manually saved memories remain untouched during nightly cleanup.
          </DialogDescription>
        </DialogHeader>

        <form
          id={formId}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={formId + '-content'}>Content</FieldLabel>
              <Textarea
                id={formId + '-content'}
                rows={3}
                value={content}
                aria-invalid={errors.content ? true : undefined}
                onChange={(event) => setContent(event.target.value)}
                placeholder="For example: The user prefers concise replies."
              />
              <FieldDescription>
                A full sentence is easier to recall than a keyword.
              </FieldDescription>
              {errors.content ? <FieldError>{errors.content}</FieldError> : null}
            </Field>

            <Field>
              <FieldLabel htmlFor={formId + '-kind-' + MEMORY_KINDS[0]}>Type</FieldLabel>
              <RadioGroup
                value={kind}
                onValueChange={(value) => setKind(value as MemoryKind)}
                className="grid grid-cols-1 gap-2 sm:grid-cols-2"
              >
                {MEMORY_KINDS.map((value) => (
                  <FieldLabel key={value} htmlFor={formId + '-kind-' + value}>
                    <Field orientation="horizontal">
                      <RadioGroupItem
                        id={formId + '-kind-' + value}
                        value={value}
                        aria-label={MEMORY_KIND_LABEL[value]}
                      />
                      <FieldTitle>{MEMORY_KIND_LABEL[value]}</FieldTitle>
                    </Field>
                  </FieldLabel>
                ))}
              </RadioGroup>
            </Field>

            <Field>
              <FieldLabel htmlFor={formId + '-tags'}>Topics</FieldLabel>
              <Input
                id={formId + '-tags'}
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                placeholder="Rookery, Memory"
              />
              <FieldDescription>
                Comma-separated. Topics connect this memory to others in the network.
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor={formId + '-importance'}>Importance</FieldLabel>
              <div className="flex items-center gap-3">
                <Slider
                  id={formId + '-importance'}
                  min={0}
                  max={1}
                  step={0.05}
                  value={[importance]}
                  onValueChange={(value) => setImportance(value[0] ?? DEFAULT_IMPORTANCE)}
                  className="flex-1"
                />
                <Badge variant="secondary" className="tabular-nums">
                  {formatPercent(importance * 100)}
                </Badge>
              </div>
              <FieldDescription>
                Important items are recalled more often and survive consolidation.
              </FieldDescription>
            </Field>
          </FieldGroup>
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={saving}>
            {saving ? <Spinner aria-label="Saving" data-icon="inline-start" /> : null}
            Save memory
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
