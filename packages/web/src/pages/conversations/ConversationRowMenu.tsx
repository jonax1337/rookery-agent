import { RowMenuButton } from '@/components/common/row-menu-button';
import {
  ArchiveIcon,
  AudioLinesIcon,
  DeleteIcon,
  ExternalLinkIcon,
  PenToolIcon as PencilIcon,
  RotateCcwIcon,
} from '@/components/icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NO_PROJECT, UNTITLED_SESSION } from '@/lib/format';
import type { Session } from '@/lib/types';
import { selectableProjects, type ProjectSummary } from './project-options';

interface ConversationRowMenuProps {
  session: Session;
  projects: readonly ProjectSummary[];
  onOpen(): void;
  onRename(): void;
  onProject(value: string): void;
  onVoice(): void;
  onArchive(archived: boolean): void;
  onReset(): void;
  onDelete(): void;
}

export function ConversationRowMenu({
  session,
  projects,
  onOpen,
  onRename,
  onProject,
  onVoice,
  onArchive,
  onReset,
  onDelete,
}: ConversationRowMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <RowMenuButton label={'Actions for ' + (session.title || UNTITLED_SESSION)} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onSelect={onOpen}>
          <ExternalLinkIcon />
          {session.kind === 'voice' ? 'Open transcript' : 'Open'}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRename}>
          <PencilIcon />
          Rename
        </DropdownMenuItem>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Assign project</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52">
            <DropdownMenuRadioGroup
              value={session.projectId ?? NO_PROJECT}
              onValueChange={onProject}
            >
              <DropdownMenuRadioItem value={NO_PROJECT}>No project</DropdownMenuRadioItem>
              {selectableProjects(projects, session.projectId).map((entry) => (
                <DropdownMenuRadioItem key={entry.id} value={entry.id}>
                  {entry.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {/* A spoken conversation is read like any other; this is the way
            back into the microphone, for both kinds. */}
        <DropdownMenuItem onSelect={onVoice}>
          <AudioLinesIcon />
          {session.kind === 'voice' ? 'Continue voice conversation' : 'Continue in voice mode'}
        </DropdownMenuItem>

        <DropdownMenuItem onSelect={() => onArchive(!session.archived)}>
          <ArchiveIcon />
          {session.archived ? 'Restore' : 'Archive'}
        </DropdownMenuItem>

        <DropdownMenuItem onSelect={onReset}>
          <RotateCcwIcon />
          Reset
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <DeleteIcon />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
