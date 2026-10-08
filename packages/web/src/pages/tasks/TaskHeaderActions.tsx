import { useRef, useState } from 'react';
import { NavLink } from 'react-router';

import {
  BanIcon,
  CheckIcon,
  PenToolIcon as PencilIcon,
  PlayIcon,
  SparklesIcon as WandSparklesIcon,
} from '@/components/icons';
import {
  RotatingText,
  RotatingTextContainer,
} from '@/components/animate-ui/primitives/texts/rotating';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';

interface RunButtonProps {
  running: boolean;
  disabled: boolean;
  onRun(): void;
}

export function RunButton({ running, disabled, onRun }: RunButtonProps) {
  return (
    <Button size="sm" disabled={disabled} onClick={onRun}>
      {running ? (
        <Spinner aria-label="Running" data-icon="inline-start" />
      ) : (
        <PlayIcon size={16} data-icon="inline-start" />
      )}
      <RotatingTextContainer text={running ? 'Running…' : 'Run'}>
        <RotatingText />
      </RotatingTextContainer>
    </Button>
  );
}

function PlanButtonContent({ planning }: { planning: boolean }) {
  return (
    <>
      {planning ? (
        <Spinner aria-label="Planning" data-icon="inline-start" />
      ) : (
        <WandSparklesIcon data-icon="inline-start" />
      )}
      <RotatingTextContainer text={planning ? 'Planning…' : 'Plan'}>
        <RotatingText />
      </RotatingTextContainer>
    </>
  );
}

interface PlanPopoverProps {
  planning: boolean;
  disabled: boolean;
  /** Resolves `true` when a plan was made. */
  onPlan(hint: string | undefined): Promise<boolean>;
}

export function PlanPopover({ planning, disabled, onPlan }: PlanPopoverProps) {
  const [open, setOpen] = useState(false);
  // The hint is read once, on submit, so typing does not re-render the popover.
  const hintRef = useRef<HTMLInputElement>(null);

  const submit = async (): Promise<void> => {
    const hint = hintRef.current?.value.trim() ?? '';
    if (!(await onPlan(hint || undefined))) return;
    setOpen(false);
    if (hintRef.current) hintRef.current.value = '';
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled}>
          <PlanButtonContent planning={planning} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <PopoverHeader>
          <PopoverTitle>Plan</PopoverTitle>
          <PopoverDescription>
            A model reviews the available agents and decides whether to assign one person or
            split the work into subtasks. This takes a few seconds.
          </PopoverDescription>
        </PopoverHeader>
        <FieldGroup className="pt-3">
          <Field>
            <FieldLabel htmlFor="task-plan-hint">Guidance for the planner</FieldLabel>
            <Input
              id="task-plan-hint"
              ref={hintRef}
              placeholder="e.g. “please assign this to Mara”"
              disabled={planning}
            />
            <FieldDescription>Leave this blank to let the model decide.</FieldDescription>
          </Field>
          <Button onClick={() => void submit()} disabled={planning}>
            <PlanButtonContent planning={planning} />
          </Button>
        </FieldGroup>
      </PopoverContent>
    </Popover>
  );
}

interface TaskMoreMenuProps {
  taskId: string;
  /** A run is active or the task is settled: completing is not possible. */
  completeDisabled: boolean;
  settled: boolean;
  onComplete(): void;
  onCancel(): void;
}

export function TaskMoreMenu({
  taskId,
  completeDisabled,
  settled,
  onComplete,
  onCancel,
}: TaskMoreMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <RowMenuButton tone="header" label="More actions" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem asChild>
          <NavLink to={'/tasks/' + taskId + '/edit'}>
            <PencilIcon data-icon="inline-start" />
            Edit
          </NavLink>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={completeDisabled} onSelect={onComplete}>
          <CheckIcon data-icon="inline-start" />
          Complete
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" disabled={settled} onSelect={onCancel}>
          <BanIcon data-icon="inline-start" />
          Cancel
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
