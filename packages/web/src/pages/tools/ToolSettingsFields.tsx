import { AUDIENCE_HINT, AUDIENCE_SHORT_LABEL, AUDIENCE_VALUES } from '@/lib/tools';
import type { Project, ToolCatalogOption, ToolServer, ToolServerAudience } from '@/lib/types';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import type { ToolDraft } from './tool-draft';

interface ToolSettingsFieldsProps {
  tool: ToolServer;
  projects: readonly Project[];
  draft: ToolDraft;
  onChange(change: Partial<ToolDraft>): void;
}

/** The fields of the detail page's form that are not credentials. */
export function ToolSettingsFields({ tool, projects, draft, onChange }: ToolSettingsFieldsProps) {
  return (
    <>
      <AudienceField value={draft.audience} onChange={(audience) => onChange({ audience })} />
      <ProjectsField
        projects={projects}
        selected={draft.projectIds}
        onChange={(projectIds) => onChange({ projectIds })}
      />
      {tool.optionDefs.map((option) => (
        <OptionField
          key={option.key}
          option={option}
          value={draft.options[option.key]}
          onChange={(value) => onChange({ options: { ...draft.options, [option.key]: value } })}
        />
      ))}
    </>
  );
}

function AudienceField({
  value,
  onChange,
}: {
  value: ToolServerAudience;
  onChange(value: ToolServerAudience): void;
}) {
  return (
    <FieldSet>
      <FieldLegend variant="label">Audience</FieldLegend>
      <FieldDescription>Determines who can see this server in their tools.</FieldDescription>
      <RadioGroup value={value} onValueChange={(next) => onChange(next as ToolServerAudience)}>
        {AUDIENCE_VALUES.map((audience) => (
          <FieldLabel key={audience} htmlFor={'audience-' + audience}>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle>{AUDIENCE_SHORT_LABEL[audience]}</FieldTitle>
                <FieldDescription>{AUDIENCE_HINT[audience]}</FieldDescription>
              </FieldContent>
              <RadioGroupItem
                value={audience}
                id={'audience-' + audience}
                aria-label={AUDIENCE_SHORT_LABEL[audience]}
              />
            </Field>
          </FieldLabel>
        ))}
      </RadioGroup>
    </FieldSet>
  );
}

function ProjectsField({
  projects,
  selected,
  onChange,
}: {
  projects: readonly Project[];
  selected: readonly string[];
  onChange(projectIds: string[]): void;
}) {
  return (
    <FieldSet>
      <FieldLegend variant="label">Projects</FieldLegend>
      <FieldDescription>
        Limit this server to specific projects. Leave every box unchecked to keep it available
        everywhere, including the workspace.
      </FieldDescription>
      {projects.length ? (
        projects.map((project) => (
          <FieldLabel key={project.id} htmlFor={'project-' + project.id}>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle>{project.name}</FieldTitle>
              </FieldContent>
              <Checkbox
                id={'project-' + project.id}
                checked={selected.includes(project.id)}
                onCheckedChange={(checked) =>
                  onChange(
                    checked === true
                      ? [...selected, project.id]
                      : selected.filter((entry) => entry !== project.id),
                  )
                }
              />
            </Field>
          </FieldLabel>
        ))
      ) : (
        <FieldDescription>No projects exist yet.</FieldDescription>
      )}
    </FieldSet>
  );
}

function OptionField({
  option,
  value,
  onChange,
}: {
  option: ToolCatalogOption;
  /** `undefined` while the draft has not been filled from the record yet. */
  value: string | undefined;
  onChange(value: string): void;
}) {
  const inputId = 'opt-' + option.key;

  return (
    <Field>
      <FieldLabel htmlFor={inputId}>{option.label}</FieldLabel>
      {option.type === 'select' ? (
        <Select value={value ?? option.default} onValueChange={onChange}>
          <SelectTrigger id={inputId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(option.choices ?? []).map((choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={inputId}
          value={value ?? ''}
          placeholder={option.default}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {option.hint ? <FieldDescription>{option.hint}</FieldDescription> : null}
    </Field>
  );
}
