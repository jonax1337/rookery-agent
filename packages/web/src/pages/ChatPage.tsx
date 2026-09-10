import { useMemo } from 'react';
import { AuiConfig, AuiProvider, Suggestions, useAui } from '@assistant-ui/react';
import { Thread, type ThreadComponents } from '@/components/assistant-ui/elements/thread.aui';
import { AssignmentsView } from '@/components/AssignmentsView';
import type { Agent, AssignmentView } from '@/lib/types';

const ASSISTANT_SUGGESTIONS = [
  {
    title: 'Fass zusammen,',
    label: 'was du über mich weißt',
    prompt: 'Fass kurz zusammen, was du über mich weißt.',
  },
  {
    title: 'Plane meinen Tag',
    label: 'mit drei Prioritäten',
    prompt: 'Hilf mir, meinen Tag mit drei Prioritäten zu planen.',
  },
  {
    title: 'Erklär mir,',
    label: 'wie du arbeitest',
    prompt: 'Erklär mir kurz, wie du arbeitest und worauf du Zugriff hast.',
  },
];

function agentSuggestions(name: string) {
  return [
    {
      title: 'Stell dich vor,',
      label: 'wofür bist du zuständig?',
      prompt: 'Stell dich kurz vor: wofür bist du zuständig und wie arbeitest du?',
    },
    {
      title: 'Woran arbeitest du',
      label: 'gerade?',
      prompt: 'Woran arbeitest du gerade, und was steht als Nächstes an?',
    },
    {
      title: 'Ich habe eine Frage',
      label: 'zu deinem Bereich',
      prompt: 'Ich habe eine Frage zu deinem Bereich: ',
    },
  ].map((entry) => ({ ...entry, prompt: entry.prompt.replace('{name}', name) }));
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return 'Noch wach?';
  if (hour < 11) return 'Guten Morgen.';
  if (hour < 14) return 'Mahlzeit.';
  if (hour < 18) return 'Guten Tag.';
  return 'Guten Abend.';
}

interface ChatPageProps {
  /** Assignments the running turn handed out. Empty for an ordinary turn. */
  assignments: AssignmentView[];
  /** Who the user is writing to. Null means the assistant. */
  counterpart: Agent | null;
  assistantName: string;
}

/**
 * The chat hub.
 *
 * Which conversation is shown is app state owned by `useSessions`; this page
 * only knows who the counterpart is, so the greeting and the suggestions can
 * address them by name. Everything else is the stock assistant-ui thread.
 */
export function ChatPage({ assignments, counterpart, assistantName }: ChatPageProps) {
  const aui = useAui();

  // Rebuilt only when the counterpart changes, so an ordinary turn never
  // re-renders the thread through a fresh components object.
  const components = useMemo<ThreadComponents>(
    () => ({
      Welcome: () => (
        <div className="mb-6 flex flex-col items-center px-4 text-center">
          <h1 className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-medium tracking-tight duration-200">
            {counterpart
              ? 'Du schreibst mit ' + counterpart.name + '.'
              : greeting() + ' Womit kann ich helfen?'}
          </h1>
          {counterpart && (
            <p className="mt-1.5 text-sm text-muted-foreground">
              {counterpart.title} · antwortet mit eigenem Gedächtnis
            </p>
          )}
        </div>
      ),
    }),
    [counterpart],
  );

  const config = AuiConfig({
    suggestions: Suggestions(
      counterpart ? agentSuggestions(counterpart.name) : ASSISTANT_SUGGESTIONS,
    ),
  });

  return (
    <>
      {assignments.length > 0 && (
        <div className="mx-auto w-full max-w-3xl px-4 pt-4">
          <AssignmentsView assignments={assignments} />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <AuiProvider extends={aui} config={config}>
          <Thread components={components} />
        </AuiProvider>
      </div>
      <span className="sr-only">Gespräch mit {counterpart?.name ?? assistantName}</span>
    </>
  );
}
