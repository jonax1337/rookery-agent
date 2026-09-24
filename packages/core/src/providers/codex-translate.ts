/**
 * Anthropic Messages <-> OpenAI Responses, both directions.
 *
 * Pure functions on purpose: this is where the whole bridge can go subtly
 * wrong (a tool call that loses its id, a stop reason that makes the harness
 * hang waiting for more), so it is the part that is worth testing properly.
 *
 * Shapes on the Codex side come from openai/codex: request per
 * `codex-rs/codex-api/src/common.rs`, events per
 * `codex-rs/codex-api/src/sse/responses.rs`.
 */

/* ------------------------------ request side ------------------------------ */

export interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  source?: { type?: string; media_type?: string; data?: string; url?: string };
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}

export interface AnthropicRequest {
  model?: string;
  system?: string | AnthropicBlock[];
  messages?: AnthropicMessage[];
  tools?: { name: string; description?: string; input_schema?: unknown }[];
  stream?: boolean;
  thinking?: { type?: string; budget_tokens?: number };
}

type ResponsesItem = Record<string, unknown>;

function blocksOf(content: string | AnthropicBlock[]): AnthropicBlock[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

function textOf(system: string | AnthropicBlock[] | undefined): string | undefined {
  if (!system) return undefined;
  if (typeof system === 'string') return system;
  const joined = system.map((block) => block.text ?? '').filter(Boolean).join('\n\n');
  return joined || undefined;
}

/** Images must reach the vision input, never the text tokenizer. */
function imageContent(block: AnthropicBlock): ResponsesItem {
  const source = block.source;
  let url: string;
  if (source?.type === 'base64' && source.data && /^image\/(png|jpeg|webp|gif)$/.test(source.media_type ?? '')) {
    url = 'data:' + source.media_type + ';base64,' + source.data;
  } else if (source?.type === 'url' && source.url) {
    url = source.url;
  } else {
    throw new Error('Unsupported image source in the ChatGPT bridge.');
  }
  return { type: 'input_image', image_url: url, detail: 'auto' };
}

/** Keep plain results as strings and multimodal results as typed content. */
function resultOutput(content: unknown): string | ResponsesItem[] {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content.map((entry): ResponsesItem => {
      const block = entry as AnthropicBlock | null;
      if (block?.type === 'image') return imageContent(block);
      return { type: 'input_text', text: typeof block?.text === 'string' ? block.text : JSON.stringify(entry) ?? '' };
    });
    return parts.some((part) => part.type === 'input_image') ? parts : parts.map((part) => part.text).join('\n');
  }
  return content === undefined ? '' : JSON.stringify(content);
}

/**
 * Reasoning effort for the backend. Anthropic expresses "think harder" as a
 * token budget, so it is mapped onto the three levels Codex accepts rather
 * than passed through.
 */
function effortFor(request: AnthropicRequest): 'low' | 'medium' | 'high' {
  const budget = request.thinking?.budget_tokens;
  if (!budget) return 'medium';
  if (budget >= 16000) return 'high';
  if (budget <= 2000) return 'low';
  return 'medium';
}

export function toResponsesRequest(
  request: AnthropicRequest,
  options: { model: string; sessionId: string },
): Record<string, unknown> {
  const input: ResponsesItem[] = [];
  const instructions = [textOf(request.system)].filter(Boolean) as string[];

  for (const message of request.messages ?? []) {
    // The backend refuses `role: "system"` outright ("System messages are not
    // allowed"), and Anthropic clients do put system turns in the history. Such
    // a turn belongs with the instructions; everything else is user-side.
    if ((message.role as string) === 'system') {
      const text = blocksOf(message.content).map((block) => block.text ?? '').filter(Boolean).join('\n');
      if (text) instructions.push(text);
      continue;
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const blocks = blocksOf(message.content);
    // Text and tool traffic are separate item kinds on the Responses side, so
    // one Anthropic message can become several items - and their order has to
    // survive, or a tool result arrives before the call it answers.
    let pendingText: string[] = [];
    const flush = (): void => {
      if (!pendingText.length) return;
      input.push({
        type: 'message',
        role,
        content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: pendingText.join('') }],
      });
      pendingText = [];
    };

    for (const block of blocks) {
      if (block.type === 'text' && block.text) {
        pendingText.push(block.text);
      } else if (block.type === 'image') {
        flush();
        if (role !== 'user') throw new Error('Images in assistant messages are not supported by the ChatGPT bridge.');
        input.push({ type: 'message', role, content: [imageContent(block)] });
      } else if (block.type === 'tool_use') {
        flush();
        input.push({
          type: 'function_call',
          name: block.name ?? '',
          arguments: JSON.stringify(block.input ?? {}),
          call_id: block.id ?? '',
        });
      } else if (block.type === 'tool_result') {
        flush();
        input.push({
          type: 'function_call_output',
          call_id: block.tool_use_id ?? '',
          output: resultOutput(block.content),
        });
      }
    }
    flush();
  }

  const tools = (request.tools ?? []).map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description ?? '',
    strict: false,
    parameters: tool.input_schema ?? { type: 'object', properties: {} },
  }));

  return {
    model: options.model,
    ...(instructions.length ? { instructions: instructions.join('\n\n') } : {}),
    input,
    ...(tools.length ? { tools, tool_choice: 'auto', parallel_tool_calls: false } : {}),
    reasoning: { effort: effortFor(request), summary: 'auto' },
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: options.sessionId,
  };
}

/* ------------------------------ response side ----------------------------- */

export interface AnthropicEvent {
  event: string;
  data: Record<string, unknown>;
}

interface ToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

/**
 * Accumulates one backend turn and emits the Anthropic event sequence for it.
 *
 * Anthropic numbers content blocks and demands start/stop around each, so this
 * has to remember which block is open; Codex sends text deltas, reasoning
 * deltas and whole function-call items interleaved.
 */
export class TurnTranslator {
  #index = -1;
  #open: 'text' | 'thinking' | null = null;
  #started = false;
  #toolCalls: ToolCall[] = [];
  #usage: Record<string, number> = {};
  readonly model: string;

  constructor(model: string) {
    this.model = model;
  }

  #start(): AnthropicEvent[] {
    if (this.#started) return [];
    this.#started = true;
    return [
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: 'msg_' + Math.random().toString(36).slice(2, 14),
            type: 'message',
            role: 'assistant',
            model: this.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
      },
    ];
  }

  #closeOpen(): AnthropicEvent[] {
    if (!this.#open) return [];
    this.#open = null;
    return [{ event: 'content_block_stop', data: { type: 'content_block_stop', index: this.#index } }];
  }

  #openBlock(kind: 'text' | 'thinking'): AnthropicEvent[] {
    if (this.#open === kind) return [];
    const events = this.#closeOpen();
    this.#index += 1;
    this.#open = kind;
    events.push({
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: this.#index,
        content_block:
          kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '', signature: '' },
      },
    });
    return events;
  }

  /** Translate one backend SSE event. Returns the Anthropic events it produces. */
  handle(event: Record<string, unknown>): AnthropicEvent[] {
    const type = event.type as string | undefined;
    if (!type) return [];

    if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
      return [
        ...this.#start(),
        ...this.#openBlock('text'),
        {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: this.#index,
            delta: { type: 'text_delta', text: event.delta },
          },
        },
      ];
    }

    if (
      (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') &&
      typeof event.delta === 'string'
    ) {
      return [
        ...this.#start(),
        ...this.#openBlock('thinking'),
        {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: this.#index,
            delta: { type: 'thinking_delta', thinking: event.delta },
          },
        },
      ];
    }

    // Function calls arrive whole rather than as argument deltas: the CLI
    // ignores `response.function_call_arguments.delta` and reads the finished
    // item, so we do the same and emit one complete tool_use block.
    if (type === 'response.output_item.done') {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type !== 'function_call') return [];
      const call: ToolCall = {
        id: String(item.call_id ?? item.id ?? ''),
        name: String(item.name ?? ''),
        argumentsJson: typeof item.arguments === 'string' ? item.arguments : '{}',
      };
      this.#toolCalls.push(call);
      const events = [...this.#start(), ...this.#closeOpen()];
      this.#index += 1;
      events.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: this.#index,
          content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
        },
      });
      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: this.#index,
          delta: { type: 'input_json_delta', partial_json: call.argumentsJson },
        },
      });
      events.push({
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index: this.#index },
      });
      return events;
    }

    if (type === 'response.completed') {
      const response = event.response as Record<string, unknown> | undefined;
      const usage = (response?.usage ?? {}) as Record<string, unknown>;
      this.#usage = {
        input_tokens: Number(usage.input_tokens ?? 0),
        output_tokens: Number(usage.output_tokens ?? 0),
      };
      const cached = (usage.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens;
      if (typeof cached === 'number') this.#usage.cache_read_input_tokens = cached;
      return this.finish();
    }

    if (type === 'response.failed' || type === 'response.incomplete') {
      const response = event.response as Record<string, unknown> | undefined;
      const error = response?.error as Record<string, unknown> | undefined;
      return [
        ...this.#start(),
        ...this.#closeOpen(),
        {
          event: 'error',
          data: {
            type: 'error',
            error: {
              type: 'api_error',
              message: String(error?.message ?? 'The ChatGPT backend ended the turn early.'),
            },
          },
        },
      ];
    }

    return [];
  }

  /** The closing events. Safe to call once; the stream ends with these. */
  finish(): AnthropicEvent[] {
    return [
      ...this.#start(),
      ...this.#closeOpen(),
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          // Without `tool_use` here the harness treats a tool call as the end
          // of the turn and never runs it.
          delta: { stop_reason: this.#toolCalls.length ? 'tool_use' : 'end_turn', stop_sequence: null },
          usage: this.#usage,
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ];
  }

  /** The same turn as one non-streaming Messages response. */
  toMessage(text: string): Record<string, unknown> {
    const content: Record<string, unknown>[] = [];
    if (text) content.push({ type: 'text', text });
    for (const call of this.#toolCalls) {
      let input: unknown = {};
      try {
        input = JSON.parse(call.argumentsJson) as unknown;
      } catch {
        input = {};
      }
      content.push({ type: 'tool_use', id: call.id, name: call.name, input });
    }
    return {
      id: 'msg_' + Math.random().toString(36).slice(2, 14),
      type: 'message',
      role: 'assistant',
      model: this.model,
      content,
      stop_reason: this.#toolCalls.length ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: this.#usage.input_tokens ?? 0, output_tokens: this.#usage.output_tokens ?? 0 },
    };
  }
}

/** Split a `text/event-stream` body into parsed `data:` payloads. */
export async function* readServerSentEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>, void, unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');
      if (data && data !== '[DONE]') {
        try {
          yield JSON.parse(data) as Record<string, unknown>;
        } catch {
          // A frame that is not JSON is not ours to interpret; skip it.
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}
