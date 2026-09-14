import test from 'node:test';
import assert from 'node:assert/strict';
import { toResponsesRequest, TurnTranslator } from '../dist/providers/codex-translate.js';

/**
 * The bridge's translation layer. Everything here is a shape the ChatGPT
 * backend or the Claude Code harness actually insists on - the interesting
 * failures are silent ones, like a tool call whose id does not survive the
 * round trip, so the assertions are about identity and ordering.
 */

const options = { model: 'gpt-5.6-sol', sessionId: 'session-1' };

test('a plain turn becomes instructions plus one input message', () => {
  const request = toResponsesRequest(
    { system: 'Be terse.', messages: [{ role: 'user', content: 'Hello' }] },
    options,
  );
  assert.equal(request.instructions, 'Be terse.');
  assert.deepEqual(request.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
  ]);
  assert.equal(request.stream, true);
  assert.equal(request.store, false);
});

test('a system turn in the history joins the instructions instead of being sent as one', () => {
  // The backend answers "System messages are not allowed" to `role: system`.
  const request = toResponsesRequest(
    {
      system: 'First.',
      messages: [
        { role: 'system', content: 'Second.' },
        { role: 'user', content: 'Hi' },
      ],
    },
    options,
  );
  assert.equal(request.instructions, 'First.\n\nSecond.');
  assert.equal(request.input.length, 1);
  assert.equal(request.input[0].role, 'user');
});

test('a tool call and its result survive the round trip in order', () => {
  const request = toResponsesRequest(
    {
      messages: [
        { role: 'user', content: 'read it' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Looking.' },
            { type: 'tool_use', id: 'call_7', name: 'Read', input: { path: 'a.txt' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_7', content: 'file body' }],
        },
      ],
      tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object' } }],
    },
    options,
  );

  assert.deepEqual(
    request.input.map((item) => item.type),
    ['message', 'message', 'function_call', 'function_call_output'],
  );
  const call = request.input[2];
  assert.equal(call.call_id, 'call_7');
  assert.equal(call.name, 'Read');
  assert.equal(call.arguments, '{"path":"a.txt"}');
  assert.deepEqual(request.input[3], {
    type: 'function_call_output',
    call_id: 'call_7',
    output: 'file body',
  });
  assert.equal(request.tools[0].name, 'Read');
  assert.deepEqual(request.tools[0].parameters, { type: 'object' });
});

test('assistant text is output_text, user text is input_text', () => {
  const request = toResponsesRequest(
    {
      messages: [
        { role: 'assistant', content: 'earlier answer' },
        { role: 'user', content: 'and now' },
      ],
    },
    options,
  );
  assert.equal(request.input[0].content[0].type, 'output_text');
  assert.equal(request.input[1].content[0].type, 'input_text');
});

/** Collect the Anthropic events a scripted backend stream produces. */
function translate(events) {
  const translator = new TurnTranslator('gpt-5.6-sol');
  const out = [];
  for (const event of events) out.push(...translator.handle(event));
  return out;
}

test('text deltas open one block, stream, and close with end_turn', () => {
  const events = translate([
    { type: 'response.output_text.delta', delta: 'Hel' },
    { type: 'response.output_text.delta', delta: 'lo' },
    { type: 'response.completed', response: { usage: { input_tokens: 7, output_tokens: 2 } } },
  ]);
  const names = events.map((event) => event.event);
  assert.deepEqual(names, [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
  const delta = events.find((event) => event.event === 'message_delta');
  assert.equal(delta.data.delta.stop_reason, 'end_turn');
  assert.deepEqual(delta.data.usage, { input_tokens: 7, output_tokens: 2 });
});

test('a function call becomes a complete tool_use block and forces stop_reason tool_use', () => {
  const events = translate([
    { type: 'response.output_text.delta', delta: 'One moment.' },
    {
      type: 'response.output_item.done',
      item: { type: 'function_call', name: 'Read', arguments: '{"path":"a.txt"}', call_id: 'call_9' },
    },
    { type: 'response.completed', response: { usage: {} } },
  ]);

  const start = events.find(
    (event) => event.event === 'content_block_start' && event.data.content_block.type === 'tool_use',
  );
  assert.equal(start.data.content_block.id, 'call_9');
  assert.equal(start.data.content_block.name, 'Read');
  // The text block must be closed before the tool block opens, and the two
  // must not share an index.
  assert.equal(start.data.index, 1);
  const json = events.find((event) => event.data?.delta?.type === 'input_json_delta');
  assert.equal(json.data.delta.partial_json, '{"path":"a.txt"}');
  // Without this the harness never runs the tool.
  const delta = events.find((event) => event.event === 'message_delta');
  assert.equal(delta.data.delta.stop_reason, 'tool_use');
});

test('reasoning summaries arrive as thinking, in their own block', () => {
  const events = translate([
    { type: 'response.reasoning_summary_text.delta', delta: 'weighing options' },
    { type: 'response.output_text.delta', delta: 'done' },
    { type: 'response.completed', response: { usage: {} } },
  ]);
  const thinking = events.find((event) => event.data?.delta?.type === 'thinking_delta');
  assert.equal(thinking.data.delta.thinking, 'weighing options');
  assert.equal(thinking.data.index, 0);
  const text = events.find((event) => event.data?.delta?.type === 'text_delta');
  assert.equal(text.data.index, 1);
});

test('a failed turn is reported as an error rather than a silent stop', () => {
  const events = translate([
    { type: 'response.failed', response: { error: { message: 'rate limited' } } },
  ]);
  const error = events.find((event) => event.event === 'error');
  assert.match(error.data.error.message, /rate limited/);
});

test('the non-streaming shape carries the same text and tool calls', () => {
  const translator = new TurnTranslator('gpt-5.6-sol');
  translator.handle({
    type: 'response.output_item.done',
    item: { type: 'function_call', name: 'Read', arguments: '{"path":"a.txt"}', call_id: 'call_3' },
  });
  translator.handle({ type: 'response.completed', response: { usage: { input_tokens: 4 } } });
  const message = translator.toMessage('some text');

  assert.equal(message.role, 'assistant');
  assert.equal(message.stop_reason, 'tool_use');
  assert.deepEqual(message.content[0], { type: 'text', text: 'some text' });
  assert.deepEqual(message.content[1], {
    type: 'tool_use',
    id: 'call_3',
    name: 'Read',
    input: { path: 'a.txt' },
  });
});
