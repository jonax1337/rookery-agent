import { useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVerticalIcon } from 'lucide-react';

import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { SlidingNumber } from '@/components/animate-ui/primitives/texts/sliding-number';
import { StatusBadge } from '@/components/common/status-badge';
import { Badge } from '@/components/ui/badge';
import { isSettableTaskStatus, TASK_STATUS_LABEL, TASK_STATUS_ORDER } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Agent, Task, TaskStatus } from '@/lib/types';

/**
 * The Kanban board `TasksPage` gave up on, back for real this time.
 *
 * It failed before because nothing kept a `sort_order` - a drag handle only
 * ever reshuffled the current render. Now the server persists both the
 * column (`status`) and the position (`sortOrder`), so this component's only
 * job is to compute the next value of each and hand it to the caller; it
 * owns no server state itself.
 *
 * Columns follow `TASK_STATUS_ORDER`. Only `open`/`done`/`cancelled` are
 * columns a person may drop a card into - `planned`/`running`/`failed`
 * belong to the runner, exactly like the row menu already enforces - so a
 * drop into one of those three is rejected and the card springs back.
 */

export interface TaskBoardProps {
  tasks: Task[];
  agentById(id: string | undefined): Agent | undefined;
  onOpenDetail(task: Task): void;
  /** Status changed by dropping into a different column. May reject (409); the board resyncs from `tasks` either way. */
  onStatusChange(task: Task, status: TaskStatus): Promise<void> | void;
  /** Persists the new position; called after every reorder, same-column or cross-column. */
  onReorder(task: Task, sortOrder: number): Promise<void> | void;
}

function byColumn(tasks: Task[]): Record<TaskStatus, string[]> {
  const columns = Object.fromEntries(TASK_STATUS_ORDER.map((status) => [status, [] as string[]])) as Record<
    TaskStatus,
    string[]
  >;
  for (const task of [...tasks].sort((a, b) => a.sortOrder - b.sortOrder)) {
    columns[task.status].push(task.id);
  }
  return columns;
}

export function TaskBoard({ tasks, agentById, onOpenDetail, onStatusChange, onReorder }: TaskBoardProps) {
  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const [columns, setColumns] = useState<Record<TaskStatus, string[]>>(() => byColumn(tasks));
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);

  // The server's view always wins once nothing is being dragged - it is the
  // one place `status`/`sortOrder` are decided; a drag in progress must not
  // be clobbered by a broadcast landing mid-gesture.
  useEffect(() => {
    if (activeId === null) setColumns(byColumn(tasks));
  }, [tasks, activeId]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function findColumn(id: UniqueIdentifier): TaskStatus | undefined {
    if ((TASK_STATUS_ORDER as string[]).includes(String(id))) return id as TaskStatus;
    return TASK_STATUS_ORDER.find((status) => columns[status].includes(String(id)));
  }

  function handleDragStart(event: DragStartEvent): void {
    setActiveId(event.active.id);
  }

  function handleDragOver(event: DragOverEvent): void {
    const { active, over } = event;
    if (!over) return;
    const fromColumn = findColumn(active.id);
    const toColumn = findColumn(over.id);
    if (!fromColumn || !toColumn || fromColumn === toColumn) return;

    setColumns((current) => {
      const from = current[fromColumn];
      const to = current[toColumn];
      const activeIndex = from.indexOf(String(active.id));
      if (activeIndex === -1) return current;
      const overIndex = to.indexOf(String(over.id));
      const insertAt = overIndex >= 0 ? overIndex : to.length;
      return {
        ...current,
        [fromColumn]: from.filter((id) => id !== String(active.id)),
        [toColumn]: [...to.slice(0, insertAt), String(active.id), ...to.slice(insertAt)],
      };
    });
  }

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    setActiveId(null);
    const task = tasksById.get(String(active.id));
    if (!task || !over) {
      setColumns(byColumn(tasks));
      return;
    }

    const targetColumn = findColumn(over.id) ?? findColumn(active.id);
    if (!targetColumn) {
      setColumns(byColumn(tasks));
      return;
    }

    // The runner owns these three columns; a manual drop into one of them is
    // exactly the move the row menu already disables, so it snaps back.
    if (targetColumn !== task.status && !isSettableTaskStatus(targetColumn)) {
      setColumns(byColumn(tasks));
      return;
    }

    const withinColumn = columns[targetColumn];
    const activeIndex = withinColumn.indexOf(String(active.id));
    const overIndex = withinColumn.indexOf(String(over.id));
    const ordered = overIndex === -1 || activeIndex === -1 ? withinColumn : arrayMove(withinColumn, activeIndex, overIndex);
    setColumns((current) => ({ ...current, [targetColumn]: ordered }));

    const index = ordered.indexOf(String(active.id));
    const prevId = index > 0 ? ordered[index - 1] : undefined;
    const nextId = index < ordered.length - 1 ? ordered[index + 1] : undefined;
    const prevOrder = prevId ? (tasksById.get(prevId)?.sortOrder ?? 0) : undefined;
    const nextOrder = nextId ? (tasksById.get(nextId)?.sortOrder ?? 0) : undefined;
    const sortOrder =
      prevOrder !== undefined && nextOrder !== undefined
        ? (prevOrder + nextOrder) / 2
        : prevOrder !== undefined
          ? prevOrder + 1000
          : nextOrder !== undefined
            ? nextOrder - 1000
            : Date.now();

    if (targetColumn !== task.status) void onStatusChange(task, targetColumn);
    void onReorder(task, sortOrder);
  }

  const activeTask = activeId ? (tasksById.get(String(activeId)) ?? null) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setColumns(byColumn(tasks))}
    >
      <div className="flex gap-4 overflow-x-auto pb-2">
        {TASK_STATUS_ORDER.map((status, index) => (
          // The Fade wrapper only owns the mount fade and the flex-child slot
          // (`flex` keeps the column stretching to the row height); the
          // droppable node itself stays untouched so dnd-kit keeps its rects.
          <Fade key={status} delay={Math.min(index * 50, 400)} className="flex w-72 shrink-0">
            <BoardColumn
              status={status}
              taskIds={columns[status]}
              tasksById={tasksById}
              agentById={agentById}
              onOpenDetail={onOpenDetail}
            />
          </Fade>
        ))}
      </div>
      <DragOverlay>
        {activeTask ? (
          <TaskCard task={activeTask} agentById={agentById} dragging onOpenDetail={() => {}} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

/* ---------------------------------- column --------------------------------- */

interface BoardColumnProps {
  status: TaskStatus;
  taskIds: string[];
  tasksById: Map<string, Task>;
  agentById(id: string | undefined): Agent | undefined;
  onOpenDetail(task: Task): void;
}

function BoardColumn({ status, taskIds, tasksById, agentById, onOpenDetail }: BoardColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const settable = isSettableTaskStatus(status);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex w-72 shrink-0 flex-col gap-2 rounded-lg border bg-muted/30 p-2',
        isOver && settable && 'ring-2 ring-primary/40',
        isOver && !settable && 'ring-2 ring-destructive/40',
      )}
    >
      <div className="flex items-center justify-between px-1 pt-1">
        <span className="text-sm font-medium">{TASK_STATUS_LABEL[status]}</span>
        <Badge variant="outline">
          <SlidingNumber number={taskIds.length} fromNumber={0} />
        </Badge>
      </div>
      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <div className="flex min-h-8 flex-col gap-2">
          {taskIds.map((id) => {
            const task = tasksById.get(id);
            if (!task) return null;
            return (
              <SortableTaskCard
                key={id}
                task={task}
                agentById={agentById}
                onOpenDetail={onOpenDetail}
              />
            );
          })}
        </div>
      </SortableContext>
    </div>
  );
}

/* ----------------------------------- card ----------------------------------- */

interface TaskCardProps {
  task: Task;
  agentById(id: string | undefined): Agent | undefined;
  onOpenDetail(task: Task): void;
  dragging?: boolean;
  handleProps?: Record<string, unknown>;
  style?: React.CSSProperties;
  setNodeRef?: (node: HTMLElement | null) => void;
}

function TaskCard({ task, agentById, onOpenDetail, dragging, handleProps, style, setNodeRef }: TaskCardProps) {
  const assignee = agentById(task.assigneeId);
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group flex flex-col gap-2 rounded-md border bg-card p-2.5 text-sm shadow-xs',
        dragging && 'rotate-1 shadow-lg',
      )}
    >
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          className="mt-0.5 shrink-0 cursor-grab touch-none text-muted-foreground/50 hover:text-muted-foreground active:cursor-grabbing"
          aria-label="Drag to reorder"
          {...handleProps}
        >
          <GripVerticalIcon className="size-3.5" />
        </button>
        <button
          type="button"
          className="min-w-0 flex-1 text-left leading-snug font-medium hover:underline"
          onClick={() => onOpenDetail(task)}
        >
          {task.title}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-5">
        <StatusBadge kind="priority" status={task.priority} />
        {task.error ? <StatusBadge kind="task" status={task.status} /> : null}
        {assignee ? (
          <Badge variant="secondary" className="max-w-32 truncate">
            {assignee.name}
          </Badge>
        ) : null}
      </div>
    </div>
  );
}

function SortableTaskCard({ task, agentById, onOpenDetail }: Omit<TaskCardProps, 'dragging'>) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <TaskCard
      task={task}
      agentById={agentById}
      onOpenDetail={onOpenDetail}
      setNodeRef={setNodeRef}
      style={style}
      handleProps={{ ...attributes, ...listeners }}
    />
  );
}
