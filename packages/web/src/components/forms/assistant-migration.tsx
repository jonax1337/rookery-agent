import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api, type MigrationPreview, type MigrationResult, type MigrationSelection, type MigrationSource } from '@/lib/api';
import { failureMessage } from '@/lib/errors';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type PreviewFile = MigrationPreview['files'][number];
type PreviewJob = NonNullable<MigrationPreview['jobs']>[number];

const EMPTY_SELECTION: MigrationSelection = { files: [], jobs: [] };
const LINK_BUTTON_CLASS = 'h-auto gap-0 p-0 text-left align-baseline';

function pluralize(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

export function AssistantMigration() {
  const [source, setSource] = useState<MigrationSource>('openclaw');
  const [sourcePath, setSourcePath] = useState('');
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [selection, setSelection] = useState<MigrationSelection>(EMPTY_SELECTION);
  const [result, setResult] = useState<MigrationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const selectedCount = selection.files.length + selection.jobs.length;
  const replacesFiles = preview?.files.some((file) => file.conflict && selection.files.includes(file.targetPath));

  function invalidate() {
    setPreview(null);
    setSelection(EMPTY_SELECTION);
    setResult(null);
    setError('');
  }

  function toggle(group: keyof MigrationSelection, id: string, checked: boolean) {
    setSelection((current) => ({
      ...current,
      [group]: checked ? [...current[group], id] : current[group].filter((value) => value !== id),
    }));
  }

  function selectGroup(group: keyof MigrationSelection, ids: string[]) {
    setSelection((current) => ({ ...current, [group]: ids }));
  }

  async function inspect() {
    invalidate();
    setBusy(true);
    try {
      const next = await api.previewMigration(source, sourcePath.trim() || undefined);
      setPreview(next);
      setSelection({
        files: next.files.map((file) => file.targetPath),
        jobs: next.jobs?.map((job) => job.sourceId) ?? [],
      });
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!preview || !selectedCount) return;
    setBusy(true);
    setError('');
    try {
      setResult(await api.importMigration(preview, selection));
      setPreview(null);
    } catch (caught) {
      setError(failureMessage(caught));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <FieldSet className="min-w-0">
      <FieldDescription>
        Bring your assistant's Markdown identity, personality, memory and compatible scheduled jobs into Rookery.
        Choose individual files and jobs after previewing. Selected destination files are backed up; source files stay in place.
        Scheduled jobs arrive paused for your review. Chat databases, credentials, gateway settings and general tool installations are not imported.
      </FieldDescription>
      <p className="text-sm"><Button asChild variant="link" className={LINK_BUTTON_CLASS}><Link to="/settings/profile">Start fresh: set up a new assistant</Link></Button></p>
      <Field>
        <FieldLabel htmlFor="migration-source">Migrate from</FieldLabel>
        <Select value={source} disabled={busy} onValueChange={(value) => { setSource(value as MigrationSource); invalidate(); }}>
          <SelectTrigger id="migration-source" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="openclaw">OpenClaw</SelectItem><SelectItem value="hermes">Hermes</SelectItem></SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="migration-path">Source folder on the Rookery server</FieldLabel>
        <Input id="migration-path" value={sourcePath} disabled={busy} placeholder={source === 'openclaw' ? '~/.openclaw/workspace' : '~/.hermes'}
          onChange={(event) => { setSourcePath(event.target.value); invalidate(); }} />
        <FieldDescription>Optional. Leave empty to use the standard folder. For a custom workspace or another computer, copy its Markdown files to a local folder first and enter that folder's absolute path.</FieldDescription>
      </Field>
      <div><Button type="button" variant="outline" disabled={busy} onClick={() => void inspect()}>{busy ? 'Working…' : 'Preview migration'}</Button></div>
      {preview ? (
        <>
          <p className="break-all text-sm text-muted-foreground">Source: {preview.sourcePath}</p>
          <SelectionBar
            summary={`Files: ${selection.files.length} of ${preview.files.length} selected`}
            noun="files"
            busy={busy}
            canSelectAll={preview.files.length > 0}
            canClear={selection.files.length > 0}
            onSelectAll={() => selectGroup('files', preview.files.map((file) => file.targetPath))}
            onClear={() => selectGroup('files', [])}
          />
          <Table>
            <TableHeader><TableRow><TableHead>File</TableHead><TableHead>Size</TableHead><TableHead>Action</TableHead></TableRow></TableHeader>
            <TableBody>
              {preview.files.map((file) => (
                <FileRow
                  key={file.targetPath}
                  file={file}
                  selected={selection.files.includes(file.targetPath)}
                  busy={busy}
                  onToggle={(checked) => toggle('files', file.targetPath, checked)}
                />
              ))}
            </TableBody>
          </Table>
          {!preview.files.length ? <p role="status" className="text-sm text-muted-foreground">No compatible files found.</p> : null}
          {preview.jobs?.length ? (
            <>
              <SelectionBar
                summary={`Scheduled jobs: ${selection.jobs.length} of ${preview.jobs.length} selected`}
                noun="jobs"
                busy={busy}
                canSelectAll
                canClear={selection.jobs.length > 0}
                onSelectAll={() => selectGroup('jobs', preview.jobs?.map((job) => job.sourceId) ?? [])}
                onClear={() => selectGroup('jobs', [])}
              />
              <Table>
                <TableHeader><TableRow><TableHead>Scheduled job</TableHead><TableHead>Schedule</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
                <TableBody>
                  {preview.jobs.map((job) => (
                    <JobRow
                      key={job.sourceId}
                      job={job}
                      selected={selection.jobs.includes(job.sourceId)}
                      busy={busy}
                      onToggle={(checked) => toggle('jobs', job.sourceId, checked)}
                    />
                  ))}
                </TableBody>
              </Table>
            </>
          ) : null}
          {preview.warnings.map((warning, index) => <p key={index} className="text-sm text-muted-foreground">{warning}</p>)}
          <FieldDescription>Import only a profile you trust: these files become instructions for your assistant. Changed files require a fresh preview.</FieldDescription>
          <div>
            <Button type="button" className="h-auto max-w-full whitespace-normal py-2" disabled={busy || !preview.canImport || !selectedCount} onClick={() => void apply()}>
              Import {selectedCount} selected {pluralize(selectedCount, 'item')}{replacesFiles ? ' and replace selected files' : ''}
            </Button>
          </div>
        </>
      ) : null}
      {result ? <ImportResult result={result} /> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </FieldSet>
  );
}

interface SelectionBarProps {
  summary: string;
  noun: 'files' | 'jobs';
  busy: boolean;
  canSelectAll: boolean;
  canClear: boolean;
  onSelectAll(): void;
  onClear(): void;
}

function SelectionBar({ summary, noun, busy, canSelectAll, canClear, onSelectAll, onClear }: SelectionBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="mr-auto text-sm">{summary}</p>
      <Button type="button" variant="outline" size="sm" disabled={busy || !canSelectAll} onClick={onSelectAll}>Select all {noun}</Button>
      <Button type="button" variant="outline" size="sm" disabled={busy || !canClear} onClick={onClear}>Clear {noun}</Button>
    </div>
  );
}

interface CheckRowProps {
  checked: boolean;
  disabled: boolean;
  onChange(checked: boolean): void;
  title: ReactNode;
  detail: ReactNode;
}

function CheckRow({ checked, disabled, onChange, title, detail }: CheckRowProps) {
  return (
    <label className="flex items-start gap-2">
      <input type="checkbox" className="mt-1 size-4 shrink-0 accent-primary" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>{title}<span className="block text-xs text-muted-foreground">{detail}</span></span>
    </label>
  );
}

interface RowProps {
  selected: boolean;
  busy: boolean;
  onToggle(checked: boolean): void;
}

function FileRow({ file, selected, busy, onToggle }: RowProps & { file: PreviewFile }) {
  const action = !selected ? 'Not selected' : file.conflict ? 'Back up and replace' : 'Copy if changed';
  return (
    <TableRow>
      <TableCell className="whitespace-normal break-all">
        <CheckRow checked={selected} disabled={busy} onChange={onToggle} title={file.targetPath} detail={`From ${file.sourcePath}`} />
      </TableCell>
      <TableCell>{file.bytes.toLocaleString()} B</TableCell>
      <TableCell>{action}</TableCell>
    </TableRow>
  );
}

function JobRow({ job, selected, busy, onToggle }: RowProps & { job: PreviewJob }) {
  const kindLabel = job.kind === 'script' ? 'Local script' : 'Assistant prompt';
  const remaining = job.remainingRuns !== undefined ? ` · ${job.remainingRuns} runs remaining` : '';
  return (
    <TableRow>
      <TableCell className="whitespace-normal">
        <CheckRow checked={selected} disabled={busy} onChange={onToggle} title={job.name} detail={`${kindLabel}${remaining}`} />
        {job.script?.path || job.prompt ? <JobReview job={job} /> : null}
      </TableCell>
      <TableCell>{job.schedule}</TableCell>
      <TableCell>{selected ? 'Paused after import' : 'Not selected'}</TableCell>
    </TableRow>
  );
}

function JobReview({ job }: { job: PreviewJob }) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs">Review {job.kind === 'script' ? 'script' : 'prompt'}</summary>
      {job.script ? (
        <p className="mt-2 break-all text-xs">
          {job.script.runtime}: {job.script.path}{job.script.noAgent ? ' · Script only' : ' · Output sent to assistant'}
        </p>
      ) : null}
      {job.assets?.length ? (
        <ul className="mt-2 space-y-1 text-xs">
          {job.assets.map((asset) => (
            <li className="break-all" key={asset.targetPath}>
              Included: {asset.sourcePath} → {asset.targetPath} ({asset.bytes.toLocaleString()} B)
            </li>
          ))}
        </ul>
      ) : null}
      {job.prompt ? <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{job.prompt}</pre> : null}
    </details>
  );
}

function ImportResult({ result }: { result: MigrationResult }) {
  const importedMarkdown = result.files.some((file) => /\.md$/i.test(file));
  return (
    <div role="status" className="space-y-2 text-sm">
      <p>
        Imported {result.files.length} {pluralize(result.files.length, 'file')}.
        {importedMarkdown ? ' Your profile applies to the next message.' : ''}
      </p>
      {result.jobs?.length ? (
        <p>
          Imported {result.jobs.length} scheduled {pluralize(result.jobs.length, 'job')}, paused for review. Review in{' '}
          <Button asChild variant="link" className={LINK_BUTTON_CLASS}><Link to="/cron">Schedules</Link></Button> before enabling.
        </p>
      ) : null}
      {result.backupPath ? <p className="break-all">Backup: {result.backupPath}</p> : null}
      {result.warnings.map((warning, index) => <p key={index} className="text-muted-foreground">{warning}</p>)}
      <p><Button asChild variant="link" className={LINK_BUTTON_CLASS}><Link to="/settings/profile">Review your profile and set its display name</Link></Button></p>
    </div>
  );
}
