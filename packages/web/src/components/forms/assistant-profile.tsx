import { useEffect, useState } from 'react';
import { api, type AssistantProfile as Profile } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

export function AssistantProfile() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState('IDENTITY.md');
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
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not load profile.'); }
    finally { setBusy(false); }
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
      setProfile((current) => current && ({ ...current, files: current.files.map((file) => file.name === selected ? { ...file, content } : file) }));
      setMessage(`${selected} saved. It applies to the next message.`);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not save profile.'); }
    finally { setBusy(false); }
  }

  const saved = profile?.files.find((file) => file.name === selected)?.content;
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
        <Select value={selected} disabled={busy || !profile} onValueChange={(value) => { setSelected(value); setMessage(''); }}>
          <SelectTrigger id="profile-file" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{(profile?.files ?? [{ name: 'IDENTITY.md' }]).map((file) => <SelectItem key={file.name} value={file.name}>{file.name}{drafts[file.name] !== undefined && drafts[file.name] !== profile?.files.find((saved) => saved.name === file.name)?.content ? ' · Unsaved' : ''}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="profile-content">{selected} content</FieldLabel>
        <Textarea id="profile-content" className="min-h-72 font-mono text-sm" spellCheck={false} disabled={busy || !profile}
          value={drafts[selected] ?? ''} onChange={(event) => { setDrafts((current) => ({ ...current, [selected]: event.target.value })); setMessage(''); }} />
        <FieldDescription>Default templates use {'{{assistantName}}'} and other settings placeholders. You can replace them with your own text.</FieldDescription>
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy || saved === undefined || saved === drafts[selected]} onClick={() => void save()}>Save {selected}</Button>
        <Button type="button" variant="outline" disabled={busy || saved === undefined || saved === drafts[selected]} onClick={() => { setDrafts((current) => ({ ...current, [selected]: saved ?? '' })); setMessage(''); }}>Discard file changes</Button>
      </div>
      {profile?.warnings.map((warning, index) => <p key={index} className="text-sm text-muted-foreground">{warning}</p>)}
      {message ? <p role="status" className="text-sm text-muted-foreground">{message}</p> : null}
      {error ? <div role="alert" className="text-sm text-destructive">{error}{!profile ? <Button type="button" variant="link" disabled={busy} onClick={() => void load()}>Retry</Button> : null}</div> : null}
    </FieldSet>
  );
}
