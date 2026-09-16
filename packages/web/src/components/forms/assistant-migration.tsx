import { useState } from 'react';
import { Link } from 'react-router';
import { api, type MigrationPreview, type MigrationResult, type MigrationSelection, type MigrationSource } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function AssistantMigration() {
  const [source, setSource] = useState<MigrationSource>('openclaw');
  const [sourcePath, setSourcePath] = useState('');
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [selection, setSelection] = useState<MigrationSelection>({ files: [], jobs: [] });
  const [result, setResult] = useState<MigrationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function invalidate() { setPreview(null); setSelection({ files: [], jobs: [] }); setResult(null); setError(''); }
  function toggle(group: keyof MigrationSelection, id: string, checked: boolean) {
    setSelection(current => ({ ...current, [group]: checked ? [...current[group], id] : current[group].filter(value => value !== id) }));
  }
  async function inspect() {
    invalidate();
    setBusy(true);
    try {
      const next = await api.previewMigration(source, sourcePath.trim() || undefined);
      setPreview(next);
      setSelection({ files: next.files.map(file => file.targetPath), jobs: next.jobs?.map(job => job.sourceId) ?? [] });
    }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not preview migration.'); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!preview || !selectedCount) return;
    setBusy(true);
    setError('');
    try { setResult(await api.importMigration(preview, selection)); setPreview(null); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not import profile.'); setPreview(null); }
    finally { setBusy(false); }
  }
  const selectedCount = selection.files.length + selection.jobs.length;
  const replacesFiles = preview?.files.some(file => file.conflict && selection.files.includes(file.targetPath));

  return (
    <FieldSet className="min-w-0">
      <FieldDescription>
        Bring your assistant's Markdown identity, personality, memory and compatible scheduled jobs into Rookery.
        Choose individual files and jobs after previewing. Selected destination files are backed up; source files stay in place.
        Scheduled jobs arrive paused for your review. Chat databases, credentials, gateway settings and general tool installations are not imported.
      </FieldDescription>
      <p className="text-sm"><Button asChild variant="link" className="h-auto gap-0 p-0 text-left align-baseline"><Link to="/settings/identity">Start fresh: set up a new assistant</Link></Button></p>
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
          <div className="flex flex-wrap items-center gap-2">
            <p className="mr-auto text-sm">Files: {selection.files.length} of {preview.files.length} selected</p>
            <Button type="button" variant="outline" size="sm" disabled={busy || !preview.files.length} onClick={() => setSelection(current => ({ ...current, files: preview.files.map(file => file.targetPath) }))}>Select all files</Button>
            <Button type="button" variant="outline" size="sm" disabled={busy || !selection.files.length} onClick={() => setSelection(current => ({ ...current, files: [] }))}>Clear files</Button>
          </div>
          <Table>
            <TableHeader><TableRow><TableHead>File</TableHead><TableHead>Size</TableHead><TableHead>Action</TableHead></TableRow></TableHeader>
            <TableBody>{preview.files.map((file) => (
              <TableRow key={file.targetPath}><TableCell className="whitespace-normal break-all"><label className="flex items-start gap-2"><input type="checkbox" className="mt-1 size-4 shrink-0 accent-primary" checked={selection.files.includes(file.targetPath)} disabled={busy} onChange={event => toggle('files', file.targetPath, event.target.checked)} /><span>{file.targetPath}<span className="block text-xs text-muted-foreground">From {file.sourcePath}</span></span></label></TableCell><TableCell>{file.bytes.toLocaleString()} B</TableCell><TableCell>{!selection.files.includes(file.targetPath) ? 'Not selected' : file.conflict ? 'Back up and replace' : 'Copy if changed'}</TableCell></TableRow>
            ))}</TableBody>
          </Table>
          {!preview.files.length ? <p role="status" className="text-sm text-muted-foreground">No compatible files found.</p> : null}
          {preview.jobs?.length ? <>
            <div className="flex flex-wrap items-center gap-2">
              <p className="mr-auto text-sm">Scheduled jobs: {selection.jobs.length} of {preview.jobs.length} selected</p>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setSelection(current => ({ ...current, jobs: preview.jobs!.map(job => job.sourceId) }))}>Select all jobs</Button>
              <Button type="button" variant="outline" size="sm" disabled={busy || !selection.jobs.length} onClick={() => setSelection(current => ({ ...current, jobs: [] }))}>Clear jobs</Button>
            </div>
            <Table>
              <TableHeader><TableRow><TableHead>Scheduled job</TableHead><TableHead>Schedule</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
              <TableBody>{preview.jobs.map((job) => <TableRow key={job.sourceId}>
                <TableCell className="whitespace-normal"><label className="flex items-start gap-2"><input type="checkbox" className="mt-1 size-4 shrink-0 accent-primary" checked={selection.jobs.includes(job.sourceId)} disabled={busy} onChange={event => toggle('jobs', job.sourceId, event.target.checked)} /><span>{job.name}<span className="block text-xs text-muted-foreground">{job.kind === 'script' ? 'Local script' : 'Assistant prompt'}{job.remainingRuns !== undefined ? ` · ${job.remainingRuns} runs remaining` : ''}</span></span></label>
                  {job.script?.path || job.prompt ? <details className="mt-2"><summary className="cursor-pointer text-xs">Review {job.kind === 'script' ? 'script' : 'prompt'}</summary>{job.script ? <p className="mt-2 break-all text-xs">{job.script.runtime}: {job.script.path}{job.script.noAgent ? ' · Script only' : ' · Output sent to assistant'}</p> : null}{job.assets?.length ? <ul className="mt-2 space-y-1 text-xs">{job.assets.map(asset => <li className="break-all" key={asset.targetPath}>Included: {asset.sourcePath} → {asset.targetPath} ({asset.bytes.toLocaleString()} B)</li>)}</ul> : null}{job.prompt ? <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{job.prompt}</pre> : null}</details> : null}
                </TableCell><TableCell>{job.schedule}</TableCell><TableCell>{selection.jobs.includes(job.sourceId) ? 'Paused after import' : 'Not selected'}</TableCell>
              </TableRow>)}</TableBody>
            </Table>
          </> : null}
          {preview.warnings.map((warning, index) => <p key={index} className="text-sm text-muted-foreground">{warning}</p>)}
          <FieldDescription>Import only a profile you trust: these files become instructions for your assistant. Changed files require a fresh preview.</FieldDescription>
          <div><Button type="button" className="h-auto max-w-full whitespace-normal py-2" disabled={busy || !preview.canImport || !selectedCount} onClick={() => void apply()}>Import {selectedCount} selected {selectedCount === 1 ? 'item' : 'items'}{replacesFiles ? ' and replace selected files' : ''}</Button></div>
        </>
      ) : null}
      {result ? (
        <div role="status" className="space-y-2 text-sm">
          <p>Imported {result.files.length} {result.files.length === 1 ? 'file' : 'files'}.{result.files.some(file => /\.md$/i.test(file)) ? ' Your profile applies to the next message.' : ''}</p>
          {result.jobs?.length ? <p>Imported {result.jobs.length} scheduled {result.jobs.length === 1 ? 'job' : 'jobs'}, paused for review. Review in <Button asChild variant="link" className="h-auto gap-0 p-0 text-left align-baseline"><Link to="/cron">Schedules</Link></Button> before enabling.</p> : null}
          {result.backupPath ? <p className="break-all">Backup: {result.backupPath}</p> : null}
          {result.warnings.map((warning, index) => <p key={index} className="text-muted-foreground">{warning}</p>)}
          <p><Button asChild variant="link" className="h-auto gap-0 p-0 text-left align-baseline"><Link to="/settings/identity">Review your profile and set its display name</Link></Button></p>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </FieldSet>
  );
}
