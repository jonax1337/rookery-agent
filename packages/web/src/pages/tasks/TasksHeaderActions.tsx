import { NavLink } from 'react-router';

import { LayoutGridIcon, MenuIcon as ListIcon, PlusIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export type TasksView = 'table' | 'board';

interface TasksHeaderActionsProps {
  view: TasksView;
  onViewChange(view: TasksView): void;
}

export function TasksHeaderActions({ view, onViewChange }: TasksHeaderActionsProps) {
  return (
    <>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={view}
        onValueChange={(value) => {
          // Radix reports `''` when the selected item is clicked again.
          if (value === 'table' || value === 'board') onViewChange(value);
        }}
      >
        <ToggleGroupItem value="table" aria-label="Table view">
          <ListIcon />
        </ToggleGroupItem>
        <ToggleGroupItem value="board" aria-label="Board view">
          <LayoutGridIcon />
        </ToggleGroupItem>
      </ToggleGroup>
      <Button asChild size="sm">
        <NavLink to="/tasks/new">
          <PlusIcon data-icon="inline-start" />
          Create task
        </NavLink>
      </Button>
    </>
  );
}
