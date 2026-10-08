import { FilterCombobox } from '@/components/common/filter-combobox';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ANY_PROJECT,
  CONVERSATION_PERIOD_LABEL,
  CONVERSATION_PERIODS,
  isConversationPeriod,
  type ConversationPeriod,
} from '@/lib/conversation-filters';
import { projectOptions, type ProjectSummary } from './project-options';

interface ConversationFilterControlsProps {
  project: string;
  period: ConversationPeriod;
  projects: readonly ProjectSummary[];
  onProjectChange(value: string): void;
  onPeriodChange(value: ConversationPeriod): void;
}

/** The project and time-period filters in the table toolbar. */
export function ConversationFilterControls({
  project,
  period,
  projects,
  onProjectChange,
  onPeriodChange,
}: ConversationFilterControlsProps) {
  return (
    <>
      <FilterCombobox
        label="Project"
        value={project}
        onChange={(next) => onProjectChange(next ?? ANY_PROJECT)}
        showClear={false}
        options={[
          { value: ANY_PROJECT, label: 'All projects' },
          ...projectOptions(projects, undefined),
        ]}
      />
      <Select
        value={period}
        onValueChange={(value) => {
          if (isConversationPeriod(value)) onPeriodChange(value);
        }}
      >
        <SelectTrigger size="sm" className="w-36" aria-label="Time period">
          <SelectValue placeholder="Time period" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {CONVERSATION_PERIODS.map((value) => (
              <SelectItem key={value} value={value}>
                {CONVERSATION_PERIOD_LABEL[value]}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </>
  );
}
