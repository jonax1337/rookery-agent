import { useEffect, useState } from 'react';
import { api, type AssistantProfile as Profile } from '@/lib/api';
import { failureMessage } from '@/lib/errors';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

const DEFAULT_FILE = 'IDENTITY.md';

export function AssistantProfile() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState(DEFAULT_FILE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function load() {
    setBusy(true);
    setError('');
    try {
      const next = await api.getProfile();
      setProfile(next);
      setDrafts(Object.fromEntries(next.files.map((file) => [file.name, file.content])));
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function save() {
    const content = drafts[selected];
    if (content === undefined) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api.saveProfileFile(selected, content);
      setProfile((current) => current && ({
        ...current,
        files: current.files.map((file) => (file.name === selected ? { ...file, content } : file)),
      }));
      setMessage(`${selected} saved. It applies to the next message.`);
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function savedContent(name: string): string | undefined {
    return profile?.files.find((file) => file.name === name)?.content;
  }

  function editSelected(content: string) {
    setDrafts((current) => ({ ...current, [selected]: content }));
    setMessage('');
  }

  function optionLabel(name: string): string {
    const draft = drafts[name];
    return draft !== undefined && draft !== savedContent(name) ? `${name} · Unsaved` : name;
  }

  const saved = savedContent(selected);
  const fileUnchanged = saved === undefined || saved === drafts[selected];
  return (
    <FieldSet className="min-w-0">
      <FieldLegend>Assistant profile</FieldLegend>
      <FieldDescription>
        These Markdown files define your assistant's identity, personality, preferences and lasting context.
        Imported profiles keep their own voice. Display settings above do not rewrite imported text.
        Files are saved separately from the settings above.
      </FieldDescription>
      <Field>
        <FieldLabel htmlFor="profile-file">Profile file</FieldLabel>
        <Select
          value={selected}
          disabled={busy || !profile}
          onValueChange={(value) => { setSelected(value); setMessage(''); }}
        >
          <SelectTrigger id="profile-file" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            {(profile?.files ?? [{ name: DEFAULT_FILE }]).map((file) => (
              <SelectItem key={file.name} value={file.name}>{optionLabel(file.name)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="profile-content">{selected} content</FieldLabel>
        <Textarea
          id="profile-content"
          className="min-h-72 font-mono text-sm"
          spellCheck={false}
          disabled={busy || !profile}
          value={drafts[selected] ?? ''}
          onChange={(event) => editSelected(event.target.value)}
        />
        <FieldDescription>Default templates use {'{{assistantName}}'} and other settings placeholders. You can replace them with your own text.</FieldDescription>
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy || fileUnchanged} onClick={() => void save()}>Save {selected}</Button>
        <Button type="button" variant="outline" disabled={busy || fileUnchanged} onClick={() => editSelected(saved ?? '')}>Discard file changes</Button>
      </div>
      {profile?.warnings.map((warning, index) => <p key={index} className="text-sm text-muted-foreground">{warning}</p>)}
      {message ? <p role="status" className="text-sm text-muted-foreground">{message}</p> : null}
      {error ? <div role="alert" className="text-sm text-destructive">{error}{!profile ? <Button type="button" variant="link" disabled={busy} onClick={() => void load()}>Retry</Button> : null}</div> : null}
    </FieldSet>
  );
}
