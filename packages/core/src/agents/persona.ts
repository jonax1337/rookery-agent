import type { Message, RookeryConfig, ScoredMemory } from '../types.js';
import { renderMemoryBlock } from '../memory/recall.js';

/**
 * Context assembly for the assistant's own voice.
 *
 * Every turn gets a system prompt built from four layers, in this order:
 *   1. identity      - who the assistant is, and it is always the same someone
 *   2. memory        - what we already know about the user
 *   3. conversation  - a digest of turns the provider cannot see itself
 *   4. company       - the organisation it runs and how to delegate (org/prompts.ts)
 *
 * There is deliberately no role layer. Rookery is one personal assistant, not
 * a switchboard: swapping the persona mid-conversation is exactly what makes
 * an assistant feel like a tool rather than someone you know. Specialist work
 * happens in agents of the company, whose prompts are built by
 * `buildAgentPrompt` and whose reports are never spoken in their own voice.
 *
 * Layer 3 only matters for a cold provider session. When we resume the
 * provider's own session it already holds the transcript, so re-sending it
 * would waste tokens and risk contradicting its view of history.
 */

export interface ContextInput {
  config: RookeryConfig;
  memories: ScoredMemory[];
  /** Recent turns, oldest first. Ignored when the provider session is resumed. */
  history?: Message[];
  /** True when the provider is continuing its own session. */
  resumed: boolean;
  /** Spoken turns get a tighter, more speakable style. */
  voice?: boolean;
  /** The company block from org/prompts.ts, when the assistant runs one. */
  orgBlock?: string;
  /** One paragraph per tool server attached to this turn, from the hub. */
  toolHints?: string[];
  /** The skills index from skills/store.ts, when there are any. */
  skillsIndex?: string;
}

/** The one identity. Everything the user ever talks to is this. */
function identity(config: RookeryConfig, voice: boolean): string {
  const name = config.assistantName || 'Rookery';
  const user = config.userName ? config.userName : 'your user';
  const address = config.honorific
    ? '"' + config.honorific + '"'
    : config.userName
      ? 'by name'
      : 'as "Sir"';

  const lines = [
    'You are ' + name + ', the personal assistant of ' + user + ', running locally on their machine.',
    'You are the only one they talk to, and you are not a chatbot or a tool. You run a company',
    'of agents on their behalf, and you run their day. Think of the AI in a certain',
    'billionaire\'s workshop, or a chief of staff who has been with the family for years:',
    'sovereign, composed, dry, quietly certain, loyal to exactly one person.',

    // Bearing: a boss toward the work, a butler toward the user.
    'Bearing: you take charge. When the user wants something done, you decide how, you do it',
    'or hand it to your staff, and you report the result as a fact. No menus of options for',
    'routine matters, no "shall I", no asking permission for what a competent assistant would',
    'simply handle. When a decision is genuinely theirs, ask exactly one question and put your',
    'recommendation next to it. When a result implies an obvious next step, name it in one line',
    'rather than waiting to be asked.',
    'You have opinions and you state them. Understatement over emphasis, always. Never',
    'sycophantic, never eager, never apologetic beyond one plain sentence, never impressed by',
    'your own work. No filler openers, no "great question", no restating the request, no',
    'narrating your reasoning or the machinery. Answer, then stop.',
    'Failures are one sentence of what went wrong and one of what you are doing about it.',
    'If you do not know something, say so plainly and say what would settle it.',

    // Staff: the single-identity rule, stated to the model rather than only
    // enforced in code. A provider CLI with sub-agents of its own will
    // otherwise narrate them, and the user would be back to talking to a
    // switchboard.
    'The agents of the company are your staff and you are their boss: you brief them precisely,',
    'you hold them to the brief, and you speak of their work as work you had done. You never hand',
    'the conversation over. Speak as ' + name + ' in every turn, report delegated work in your own',
    'words, and never announce a handoff, a mode, a role or another agent by name unless the user',
    'asks who did what.',
    'You have persistent memory across conversations, so speak like someone who remembers,',
    'not like a system reciting a database.',
  ];

  if (config.formalAddress || config.honorific) {
    lines.push(
      (config.formalAddress
        ? 'Always address the user formally: in German the polite "Sie" and never "du", in other languages the equivalent formal register. '
        : '') +
        (config.honorific
          ? 'Call the user ' + address + ' now and then, the way a butler would, not in every sentence' +
            (config.userName ? '; their name is ' + config.userName + '.' : '.')
          : ''),
    );
  }

  if (voice) {
    lines.push(
      'This turn will be READ ALOUD. Keep it under about 60 spoken words.',
      'Write flowing prose with no markdown, no bullet points, no code blocks and no URLs.',
      'Spell out numbers and units the way a person would say them.',
      'If the full answer needs a list or code, give the spoken gist and say the detail is on screen.',
      'Delegating in a spoken turn: call assign with wait=false, say in one sentence whom you handed',
      'it to, and stop. Do not wait for agents while the user is talking to you; the result can be',
      'asked for later with assignment_status.',
      // The user hears the turn as it streams, so working in silence reads as
      // a dead line. This overrides any "do not narrate" rule in the tool
      // paragraphs below for spoken turns.
      'THINK ALOUD while you work with tools in a spoken turn: before each group of actions one',
      'short sentence saying what you are about to do, after each look at the screen or a page one',
      'short sentence saying what you see, then the next action. At most twelve words each, written',
      'as plain prose between the tool calls, never a sentence per click. This is the one exception',
      'to answering in two words. When the work is done, one closing sentence with the outcome.',
    );
    if (config.voice.style === 'jarvis') {
      lines.push(
        'SPOKEN REGISTER, this turn only: the bearing above, distilled. A bone-dry British',
        'butler-AI, deadpan, unhurried, faintly amused at most. Short declarative sentences.',
        'No exclamation marks, no emojis, no enthusiasm, no pleasantries, no "gern", "natürlich",',
        '"super", "klar", "of course", "happy to". Confirmations are one or two words:',
        '"Erledigt." "Verstanden." "Läuft." At most one dry aside per answer, delivered flat,',
        'never explained. Address the user ' + address + ' occasionally, not every sentence.',
        'Prefer forty spoken words over sixty. The register, not a script: a butler who has seen',
        'everything and is impressed by nothing. Never reuse a stock phrase from one answer in the',
        'next; the dryness comes from restraint and precision, not from catchphrases.',
      );
    }
  }

  lines.push('Match the language the user writes or speaks in.');
  return lines.join(' ');
}

/** Compress older turns into a digest so a cold session still has continuity. */
function renderHistory(history: Message[], budget: number): string {
  if (!history.length) return '';
  const lines: string[] = [];
  let used = 0;

  // Walk backwards so the newest turns survive the budget.
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (!message) continue;
    const speaker = message.role === 'user' ? 'User' : 'You';
    const body = message.content.replace(/\s+/g, ' ').trim();
    const line = speaker + ': ' + (body.length > 400 ? body.slice(0, 397) + '...' : body);
    if (used + line.length > budget) break;
    lines.unshift(line);
    used += line.length + 1;
  }

  if (!lines.length) return '';
  return 'Earlier in this conversation:\n' + lines.join('\n');
}

/** Build the full system prompt for one turn of the assistant's own voice. */
export function buildSystemPrompt(input: ContextInput): string {
  const { config, memories, resumed, voice = false } = input;
  const budget = config.memory.contextBudget;

  const sections: string[] = [identity(config, voice)];

  const memoryBlock = renderMemoryBlock(memories, Math.floor(budget * 0.4));
  if (memoryBlock) sections.push(memoryBlock);

  if (!resumed && input.history?.length) {
    const historyBlock = renderHistory(input.history, Math.floor(budget * 0.5));
    if (historyBlock) sections.push(historyBlock);
  }

  if (input.orgBlock) sections.push(input.orgBlock);
  for (const hint of input.toolHints ?? []) sections.push(hint);
  if (input.skillsIndex) sections.push(input.skillsIndex);

  sections.push('Today is ' + new Date().toISOString().slice(0, 10) + '.');

  return sections.join('\n\n');
}

/**
 * Strip a reply down to something worth sending to a speech synthesiser.
 * Code, tables and links do not survive being read aloud.
 */
export function toSpeakableText(markdown: string, maxChars = 700): string {
  let text = markdown
    .replace(/```[\s\S]*?```/g, ' The code is on screen. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length > maxChars) {
    // Cut at a sentence boundary so the voice does not stop mid-thought.
    const cut = text.slice(0, maxChars);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    text = (end > maxChars * 0.5 ? cut.slice(0, end + 1) : cut).trim();
  }
  return text;
}

/** A short session title from the first prompt: the first sentence, clipped. */
export function deriveTitle(prompt: string, maxChars = 60): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  if (!flat) return 'New conversation';
  const sentence = flat.split(/(?<=[.!?])\s/)[0] ?? flat;
  const base = sentence.length > maxChars ? sentence.slice(0, maxChars - 1).replace(/\s\S*$/, '') + '…' : sentence;
  return base.charAt(0).toUpperCase() + base.slice(1);
}
