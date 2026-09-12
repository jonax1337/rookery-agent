import { useEffect, useState } from 'react';
import { api, type VoiceKeyStatus } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';

export function VoiceKeys({ onSaved }: { onSaved(): void }) {
  const [status, setStatus] = useState<VoiceKeyStatus | null>(null);
  const [values, setValues] = useState({ openai: '', elevenlabs: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  async function load() {
    try { setStatus(await api.voiceKeys()); setError(''); }
    catch { setError('Could not load key status. Try again.'); }
  }
  useEffect(() => { void load(); }, []);
  async function save(name: 'openai' | 'elevenlabs', value: string | null) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      setStatus(await api.saveVoiceKeys({ [name]: value }));
      setValues((current) => ({ ...current, [name]: '' }));
      setMessage(value === null ? 'Saved key removed. An environment key, if present, remains active.' : 'Key saved. It applies immediately; use voice preview to check it.');
      onSaved();
    } catch { setError('Could not save the key. Check the connection and try again.'); }
    finally { setBusy(false); }
  }
  return (
    <FieldSet>
      <FieldLegend>Speech service keys</FieldLegend>
      <FieldDescription>Optional for OpenAI and ElevenLabs speech. Stored locally on this server, never shown again. No restart required.</FieldDescription>
      {(['openai', 'elevenlabs'] as const).map((name) => (
        <Field key={name}>
          <FieldLabel htmlFor={`voice-key-${name}`}>{name === 'openai' ? 'OpenAI' : 'ElevenLabs'} API key</FieldLabel>
          <Input id={`voice-key-${name}`} type="password" autoComplete="new-password" spellCheck={false}
            disabled={busy || !status} value={values[name]}
            placeholder={status?.[name].configured ? 'Key configured — enter a replacement' : 'Enter API key'}
            onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))} />
          <FieldDescription>{status ? status[name].source === 'environment' ? 'Provided by the server environment. Saving here overrides it.' : status[name].configured ? 'A key is saved on this server.' : 'No key configured.' : 'Loading key status…'}</FieldDescription>
          <div className="flex gap-2">
            <Button type="button" variant="outline" disabled={busy || !status || !values[name].trim()} onClick={() => void save(name, values[name].trim())}>Save key</Button>
            <Button type="button" variant="outline" disabled={busy || status?.[name].source !== 'saved'} onClick={() => void save(name, null)}>Remove saved key</Button>
          </div>
        </Field>
      ))}
      {message ? <p role="status" className="text-sm text-muted-foreground">{message}</p> : null}
      {error ? <div role="alert" className="text-sm text-destructive">{error} <Button type="button" variant="link" onClick={() => void load()}>Retry status</Button></div> : null}
    </FieldSet>
  );
}
