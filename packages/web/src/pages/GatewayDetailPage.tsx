import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, useParams } from 'react-router';
import { PlusIcon, RadioTowerIcon, SendIcon, XIcon } from 'lucide-react';
import { toast } from 'sonner';

import { FormPage } from '@/components/blocks/form-page';
import { PageBody } from '@/components/blocks/page-body';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { MetaList } from '@/components/common/meta-list';
import { FormFieldsSkeleton } from '@/components/forms/form-kit';
import { usePageMeta } from '@/components/shell/page-meta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useGateway } from '@/hooks/useGateways';
import { reportFailure } from '@/lib/errors';
import { PERMISSION_HINT, PERMISSION_LABEL } from '@/lib/format';
import { gatewayStateLook } from '@/lib/gateways';
import { formatDateTime } from '@/lib/stats';
import type {
  GatewayStatus,
  PermissionLevel,
  TelegramGatewayConfig,
  TelegramPushConfig,
} from '@/lib/types';
import { useConfig } from '@/providers/rookery-provider';

/**
 * The Telegram gateway's own settings.
 *
 * The page mirrors two templates rather than inventing a third: the frame,
 * the status badge and the `MetaList` come from `ToolDetailPage`; the draft,
 * "Speichern" and the deep-compared dirty flag come straight from
 * `SettingsPage`, because this is the same kind of write - a `PATCH
 * /api/config` deep merge, not a record of its own with a `PUT`. There is no
 * `useDraft` here for exactly that reason: that hook's dirty flag is "was
 * anything touched", and this page needs "does the draft still match the
 * server", the same distinction `SettingsPage` already made.
 *
 * `GatewayId` only ever names `telegram` today, but the route stays
 * `/gateways/:id` so a second gateway needs a new `id` here and nothing else
 * upstream.
 */

const FORM_ID = 'gateway-telegram';

const PERMISSION_LEVELS: PermissionLevel[] = ['chat', 'read', 'write', 'full'];

function makeDraft(config: TelegramGatewayConfig): TelegramGatewayConfig {
  return { ...config, push: { ...config.push } };
}

/** Where the running channel got its token, in words. */
const TOKEN_SOURCE_LABEL: Record<GatewayStatus['tokenSource'], string> = {
  config: 'Hier eingetragen',
  env: 'Umgebungsvariable TELEGRAM_BOT_TOKEN',
  none: 'Noch keiner',
};

export function GatewayDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { gateway, loading, error, refresh, test } = useGateway(id);
  const { config, save } = useConfig();

  const [draft, setDraft] = useState<TelegramGatewayConfig | null>(
    config ? makeDraft(config.gateways.telegram) : null,
  );
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [newId, setNewId] = useState('');
  const [newIdError, setNewIdError] = useState<string | null>(null);

  // Same guard as SettingsPage: a socket-driven refetch must not overwrite a
  // half-finished edit, so `touched` is read synchronously and cannot be state.
  const touched = useRef(false);
  useEffect(() => {
    if (config && !touched.current) setDraft(makeDraft(config.gateways.telegram));
  }, [config]);

  const update = useCallback((make: (current: TelegramGatewayConfig) => TelegramGatewayConfig) => {
    touched.current = true;
    setDraft((current) => (current ? make(current) : current));
  }, []);

  const set = useCallback(
    (patch: Partial<TelegramGatewayConfig>) => update((current) => ({ ...current, ...patch })),
    [update],
  );
  const setPush = useCallback(
    (patch: Partial<TelegramPushConfig>) =>
      update((current) => ({ ...current, push: { ...current.push, ...patch } })),
    [update],
  );

  const dirty = draft !== null && config !== null && !deepEqual(draft, config.gateways.telegram);

  const discard = useCallback(() => {
    touched.current = false;
    setDraft(config ? makeDraft(config.gateways.telegram) : null);
  }, [config]);

  const draftRef = useRef(draft);
  draftRef.current = draft;

  const submit = useCallback(async (): Promise<void> => {
    const pending = draftRef.current;
    if (!pending) return;
    setSaving(true);
    try {
      // The whole gateways object goes out, but PATCH merges deeply - the
      // config's other channels (once there are any) survive untouched.
      if (!(await save({ gateways: { telegram: pending } }))) return;
      if (draftRef.current === pending) touched.current = false;
      await refresh();
    } catch (caught) {
      reportFailure('Speichern', caught);
    } finally {
      setSaving(false);
    }
  }, [refresh, save]);

  const runTest = useCallback(async (): Promise<void> => {
    setTesting(true);
    try {
      // A channel that cannot send (not running, no recipient) answers 400,
      // which surfaces here as a thrown `ApiError` - there is no `ok: false`.
      const result = await test('telegram');
      toast('Testnachricht gesendet', { description: 'An ' + result.recipient + ' geschickt.' });
    } catch (caught) {
      reportFailure('Testnachricht', caught);
    } finally {
      setTesting(false);
    }
  }, [test]);

  const addAllowedId = useCallback((): void => {
    const trimmed = newId.trim();
    if (!trimmed) return;
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      setNewIdError('Nur eine positive, ganze Telegram-ID.');
      return;
    }
    if (draft?.allowedUserIds.includes(parsed)) {
      setNewIdError('Diese ID steht schon in der Liste.');
      return;
    }
    // The first allowed id is what pairing mode was opened for, so it closes
    // itself here rather than waiting to be switched off and forgotten.
    set({ allowedUserIds: [...(draft?.allowedUserIds ?? []), parsed], pairing: false });
    setNewId('');
    setNewIdError(null);
  }, [draft, newId, set]);

  const removeAllowedId = useCallback(
    (value: number): void => {
      if (!draft) return;
      set({
        allowedUserIds: draft.allowedUserIds.filter((entry) => entry !== value),
        push: { ...draft.push, recipients: draft.push.recipients.filter((entry) => entry !== value) },
      });
    },
    [draft, set],
  );

  const toggleRecipient = useCallback(
    (value: number, on: boolean): void => {
      if (!draft) return;
      setPush({
        recipients: on
          ? [...draft.push.recipients, value]
          : draft.push.recipients.filter((entry) => entry !== value),
      });
    },
    [draft, setPush],
  );

  usePageMeta(
    {
      breadcrumb: [{ label: 'Gateway', to: '/gateways' }, { label: gateway?.label ?? 'Gateway' }],
      actions: gateway ? (
        <div className="flex items-center gap-2">
          {dirty ? (
            <Badge variant="outline" className="hidden font-normal text-muted-foreground sm:inline-flex">
              Ungespeicherte Änderungen
            </Badge>
          ) : null}
          <Button type="button" variant="outline" size="sm" disabled={testing} onClick={() => void runTest()}>
            {testing ? <Spinner aria-label="Wird gesendet" /> : <SendIcon data-icon="inline-start" />}
            Testnachricht senden
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={!dirty || saving} onClick={discard}>
            Verwerfen
          </Button>
          <Button type="submit" form={FORM_ID} size="sm" disabled={!dirty || saving}>
            {saving ? <Spinner aria-label="Wird gespeichert" /> : null}
            Speichern
          </Button>
        </div>
      ) : undefined,
    },
    [gateway, dirty, saving, testing, discard, runTest],
  );

  /* -------------------------------- Zustände ------------------------------- */

  if (id !== 'telegram') {
    return (
      <PageBody width="3xl">
        <EmptyState
          icon={RadioTowerIcon}
          title="Dieses Gateway gibt es nicht"
          description="Der Eintrag wurde entfernt, oder die Adresse stimmt nicht."
          actionLabel="Zu den Gateways"
          actionTo="/gateways"
        />
      </PageBody>
    );
  }

  if (!gateway && loading) {
    return (
      <PageBody width="3xl">
        <Card>
          <CardHeader>
            <CardTitle>Status</CardTitle>
          </CardHeader>
          <CardContent>
            <FormFieldsSkeleton fields={4} />
          </CardContent>
        </Card>
      </PageBody>
    );
  }

  if (!gateway) {
    return (
      <PageBody width="3xl">
        {error ? (
          <ServerOffline onRetry={() => void refresh()} />
        ) : (
          <EmptyState
            icon={RadioTowerIcon}
            title="Diesen Kanal gibt es nicht"
            description="Der Eintrag wurde entfernt, oder die Adresse stimmt nicht."
            actionLabel="Zu den Gateways"
            actionTo="/gateways"
          />
        )}
      </PageBody>
    );
  }

  const look = gatewayStateLook(gateway);

  return (
    <PageBody width="3xl">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={look.variant} className="gap-1">
            {look.icon ? <look.icon className={look.iconClassName} aria-hidden="true" /> : null}
            {look.label}
          </Badge>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
          <CardDescription>
            Der Bot-Token wird unten eingetragen und gilt sofort - ein Neustart ist nicht nötig.
            Gespeichert wird er in <code>~/.rookery/config.json</code>, ausgeliefert wird er nie:
            diese Seite erfährt nur, <em>ob</em> einer gesetzt ist. Ein neuer Bot entsteht bei{' '}
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              @BotFather
            </a>
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MetaList
            columns={2}
            items={[
              { label: 'Token vorhanden', value: gateway.configured ? 'Ja' : 'Nein' },
              { label: 'Quelle', value: TOKEN_SOURCE_LABEL[gateway.tokenSource] },
              { label: 'Läuft', value: gateway.running ? 'Ja' : 'Nein' },
              { label: 'Bot-Name', value: gateway.botUsername ? '@' + gateway.botUsername : '' },
              { label: 'Letzter Fehler', value: gateway.lastError },
              {
                label: 'Letztes Ereignis',
                value: gateway.lastEventAt ? formatDateTime(gateway.lastEventAt) : '',
              },
            ]}
          />
        </CardContent>
      </Card>

      {draft === null ? (
        <Card>
          <CardHeader>
            <CardTitle>Einstellungen</CardTitle>
          </CardHeader>
          <CardContent>
            <FormFieldsSkeleton fields={5} />
          </CardContent>
        </Card>
      ) : (
        <FormPage
          formId={FORM_ID}
          showActions={false}
          onSubmit={submit}
          title="Einstellungen"
          description="Wird mit „Speichern“ geschrieben und gilt sofort."
        >
          <FieldSet>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="gw-enabled">Kanal an</FieldLabel>
                <FieldDescription>
                  Aus schaltet den Bot ab, unabhängig davon, wie viele IDs erlaubt sind.
                </FieldDescription>
              </FieldContent>
              <Switch
                id="gw-enabled"
                checked={draft.enabled}
                onCheckedChange={(on) => set({ enabled: on })}
              />
            </Field>
          </FieldSet>

          <Field>
            <FieldLabel htmlFor="gw-token">Bot-Token</FieldLabel>
            <Input
              id="gw-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              disabled={gateway.tokenSource === 'env'}
              value={draft.token ?? ''}
              placeholder={gateway.configured ? 'Gesetzt - leer lassen, um ihn zu behalten' : 'Von @BotFather'}
              onChange={(event) => set({ token: event.target.value })}
            />
            <FieldDescription>
              {gateway.tokenSource === 'env' ? (
                <>
                  Kommt aus der Umgebungsvariable <code>TELEGRAM_BOT_TOKEN</code> und hat hier
                  Vorrang. Zum Bearbeiten an dieser Stelle die Variable entfernen und den Server
                  neu starten.
                </>
              ) : (
                <>
                  Das Feld bleibt beim Laden leer - der gespeicherte Token wird nie zurückgegeben.
                  Leer lassen behält ihn, ein neuer Wert ersetzt ihn.
                  {gateway.configured ? (
                    <>
                      {' '}
                      <button
                        type="button"
                        className="underline underline-offset-2 hover:text-destructive"
                        onClick={() => set({ token: null })}
                      >
                        Token entfernen
                      </button>
                      {draft.token === null ? ' - wird beim Speichern gelöscht.' : null}
                    </>
                  ) : null}
                </>
              )}
            </FieldDescription>
          </Field>

          <FieldSet>
            <FieldLegend variant="label">Zugriff</FieldLegend>
            <FieldDescription>Was Turns aus diesem Kanal dürfen.</FieldDescription>
            <RadioGroup
              value={draft.permission}
              onValueChange={(value) => set({ permission: value as PermissionLevel })}
            >
              {PERMISSION_LEVELS.map((level) => (
                <FieldLabel key={level} htmlFor={'gw-permission-' + level}>
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>{PERMISSION_LABEL[level]}</FieldTitle>
                      <FieldDescription>{PERMISSION_HINT[level]}</FieldDescription>
                    </FieldContent>
                    <RadioGroupItem value={level} id={'gw-permission-' + level} aria-label={PERMISSION_LABEL[level]} />
                  </Field>
                </FieldLabel>
              ))}
            </RadioGroup>
          </FieldSet>

          <Field>
            <FieldLabel htmlFor="gw-model">Modell</FieldLabel>
            <Input
              id="gw-model"
              value={draft.model ?? ''}
              placeholder="Standard des Assistenten"
              onChange={(event) => set({ model: event.target.value })}
            />
            <FieldDescription>Leer bedeutet: das Modell, das sonst gilt.</FieldDescription>
          </Field>

          <FieldSet>
            <FieldLegend variant="label">Erlaubte IDs</FieldLegend>
            <FieldDescription>
              Eine leere Liste schaltet den Kanal aus - es gibt kein „alle erlauben“. Die eigene
              ID bekommt man, indem man dem Bot <code>/id</code> schreibt; dafür ist beim ersten
              Mal die Kopplung unten nötig.
            </FieldDescription>
            {draft.allowedUserIds.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {draft.allowedUserIds.map((value) => (
                  <Badge key={value} variant="secondary" className="gap-1 font-mono tabular-nums">
                    {value}
                    <button
                      type="button"
                      aria-label={value + ' entfernen'}
                      className="rounded-full hover:text-destructive"
                      onClick={() => removeAllowedId(value)}
                    >
                      <XIcon data-icon="inline-end" />
                    </button>
                  </Badge>
                ))}
              </div>
            ) : null}
            <Field data-invalid={newIdError ? true : undefined}>
              <InputGroup>
                <InputGroupInput
                  id="gw-new-id"
                  inputMode="numeric"
                  placeholder="Telegram-ID, z. B. 123456789"
                  value={newId}
                  onChange={(event) => {
                    setNewId(event.target.value);
                    setNewIdError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addAllowedId();
                    }
                  }}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton onClick={addAllowedId}>
                    <PlusIcon data-icon="inline-start" />
                    Hinzufügen
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
              {newIdError ? <p className="text-sm text-destructive">{newIdError}</p> : null}
            </Field>

            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="gw-pairing">Kopplung</FieldLabel>
                <FieldDescription>
                  Lässt den Bot mit leerer Liste laufen, damit <code>/id</code> antworten kann -
                  sonst wartet er auf eine ID, die man nur von ihm bekommt. Es antwortet
                  ausschließlich <code>/id</code>, und zwar nur mit der Nummer des Absenders;
                  jede andere Nachricht fällt durch. Beim Hinzufügen der ersten ID schaltet sich
                  die Kopplung selbst ab.
                </FieldDescription>
              </FieldContent>
              <Switch
                id="gw-pairing"
                checked={draft.pairing}
                onCheckedChange={(on) => set({ pairing: on })}
              />
            </Field>
          </FieldSet>

          <FieldSet>
            <FieldLegend variant="label">Push</FieldLegend>
            <FieldDescription>
              Was der Assistent von sich aus schickt, ohne dass gerade ein Gespräch läuft.
            </FieldDescription>

            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="gw-push-enabled">Push an</FieldLabel>
                <FieldDescription>Schaltet alle Arten unten mit ab, wenn aus.</FieldDescription>
              </FieldContent>
              <Switch
                id="gw-push-enabled"
                checked={draft.push.enabled}
                onCheckedChange={(on) => setPush({ enabled: on })}
              />
            </Field>

            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="gw-push-assignments">Aufträge</FieldLabel>
              </FieldContent>
              <Switch
                id="gw-push-assignments"
                checked={draft.push.assignments}
                onCheckedChange={(on) => setPush({ assignments: on })}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="gw-push-cron">Zeitpläne</FieldLabel>
              </FieldContent>
              <Switch
                id="gw-push-cron"
                checked={draft.push.cron}
                onCheckedChange={(on) => setPush({ cron: on })}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="gw-push-sleep">Schlaf</FieldLabel>
              </FieldContent>
              <Switch
                id="gw-push-sleep"
                checked={draft.push.sleep}
                onCheckedChange={(on) => setPush({ sleep: on })}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="gw-push-tasks">Aufgaben</FieldLabel>
              </FieldContent>
              <Switch
                id="gw-push-tasks"
                checked={draft.push.tasks}
                onCheckedChange={(on) => setPush({ tasks: on })}
              />
            </Field>

            <div className="grid gap-4 @md/main:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="gw-quiet-from">Ruhezeit von</FieldLabel>
                <Input
                  id="gw-quiet-from"
                  type="time"
                  value={draft.push.quietFrom}
                  onChange={(event) => setPush({ quietFrom: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="gw-quiet-until">Ruhezeit bis</FieldLabel>
                <Input
                  id="gw-quiet-until"
                  type="time"
                  value={draft.push.quietUntil}
                  onChange={(event) => setPush({ quietUntil: event.target.value })}
                />
              </Field>
            </div>
            <FieldDescription>Leer bei beidem heißt: keine Ruhezeit.</FieldDescription>

            <NumberField
              id="gw-max-per-hour"
              label="Obergrenze je Stunde"
              value={draft.push.maxPerHour}
              min={1}
              max={1000}
              suffix="Nachrichten"
              onChange={(value) => setPush({ maxPerHour: value })}
            />

            <Field>
              <FieldLabel>Empfänger</FieldLabel>
              <FieldDescription>
                Teilmenge der erlaubten IDs. Leer heißt: die erste erlaubte ID.
              </FieldDescription>
              {draft.allowedUserIds.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {draft.allowedUserIds.map((value) => (
                    <Label
                      key={value}
                      htmlFor={'gw-recipient-' + value}
                      className="flex items-center gap-2 font-mono font-normal tabular-nums"
                    >
                      <Checkbox
                        id={'gw-recipient-' + value}
                        checked={draft.push.recipients.includes(value)}
                        onCheckedChange={(checked) => toggleRecipient(value, checked === true)}
                      />
                      {value}
                    </Label>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Erst oben eine ID erlauben, dann lässt sich hier ein Empfänger wählen.
                </p>
              )}
            </Field>
          </FieldSet>
        </FormPage>
      )}

      <p className="text-xs text-muted-foreground">
        Alle Gateways liegen unter{' '}
        <NavLink to="/gateways" className="underline underline-offset-2">
          Gateway
        </NavLink>
        .
      </p>
    </PageBody>
  );
}

/* --------------------------------- helpers -------------------------------- */

/** Same shallow recursive compare as `SettingsPage` - the two never share it. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!deepEqual(left[key], right[key])) return false;
  }
  return true;
}

function NumberField({
  id,
  label,
  value,
  min,
  max,
  suffix,
  description,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  description?: string;
  onChange(value: number): void;
}) {
  const [raw, setRaw] = useState<string | null>(null);
  const shown = raw ?? String(value);
  const parsed = Number(shown);
  const invalid = shown.trim() === '' || !Number.isInteger(parsed) || parsed < min || parsed > max;

  return (
    <Field data-invalid={invalid || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id={id}
          inputMode="numeric"
          value={shown}
          aria-invalid={invalid || undefined}
          onChange={(event) => {
            const next = event.target.value;
            setRaw(next);
            const number = Number(next);
            if (next.trim() !== '' && Number.isInteger(number) && number >= min && number <= max) {
              onChange(number);
            }
          }}
          onBlur={() => setRaw(null)}
        />
        {suffix ? (
          <InputGroupAddon align="inline-end">
            <InputGroupText>{suffix}</InputGroupText>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError>
        {invalid ? 'Bitte eine ganze Zahl zwischen ' + min + ' und ' + max + '.' : null}
      </FieldError>
    </Field>
  );
}
