import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexBridge } from '../dist/providers/codex-bridge.js';

/**
 * The bridge's HTTP surface, as the `claude` binary actually uses it.
 *
 * Both cases here are what a mid-session `/model` switch depends on, and both
 * failed silently before: a missing model list, and a validation probe that
 * sends no `stream` field and reads `usage.input_tokens` off a JSON body.
 *
 * The model list is read at call time from `CODEX_HOME`, which the suite's
 * setup points at an empty directory; a fixture of its own keeps the expected
 * list stable. Nothing here reaches the ChatGPT backend - the list never calls
 * it, and the turn runs against a stubbed `fetch`.
 */

const home = mkdtempSync(join(tmpdir(), 'codex-bridge-test-'));
writeFileSync(
  join(home, 'models_cache.json'),
  JSON.stringify({
    models: [
      { slug: 'gpt-6-astra', visibility: 'list', priority: 1 },
      { slug: 'gpt-reserve', visibility: 'hide', priority: 3 },
      { slug: 'gpt-5.6-sol', visibility: 'list', priority: 4 },
    ],
  }),
  'utf8',
);

/** The real one, kept aside so a test can call the bridge while `fetch` is stubbed. */
const realFetch = globalThis.fetch;

const session = { credentials: async () => ({ accessToken: 'token', accountId: 'account' }) };

const SSE =
  'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n' +
  'data: {"type":"response.completed","response":{"usage":{"input_tokens":11,"output_tokens":1}}}\n\n';

/** One started bridge, with `CODEX_HOME` and the ChatGPT backend stubbed out. */
async function withBridge(run) {
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  globalThis.fetch = async () =>
    new Response(new Blob([SSE]).stream(), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  const bridge = new CodexBridge(session);
  try {
    await run(await bridge.start());
  } finally {
    globalThis.fetch = realFetch;
    await bridge.close();
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  }
}

test("the model list is served in Anthropic's list shape", async () => {
  await withBridge(async ({ baseUrl, token }) => {
    const response = await realFetch(baseUrl + '/v1/models?limit=1000&beta=true', {
      headers: { authorization: 'Bearer ' + token },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data, [
      { id: 'gpt-6-astra', display_name: 'GPT-6-astra', type: 'model', created_at: '1970-01-01T00:00:00Z' },
      { id: 'gpt-5.6-sol', display_name: 'GPT-5.6-sol', type: 'model', created_at: '1970-01-01T00:00:00Z' },
    ]);
    assert.equal(body.first_id, 'gpt-6-astra');
    assert.equal(body.last_id, 'gpt-5.6-sol');
    assert.equal(body.has_more, false);
  });
});

test('the model list needs the same token the messages path needs', async () => {
  await withBridge(async ({ baseUrl, token }) => {
    assert.equal((await realFetch(baseUrl + '/v1/models')).status, 401);
    assert.equal((await realFetch(baseUrl + '/v1/models', { headers: { 'x-api-key': 'wrong' } })).status, 401);
    assert.equal(
      (await realFetch(baseUrl + '/v1/completions', { headers: { 'x-api-key': token } })).status,
      404,
    );
  });
});

test('a turn that did not ask to stream is answered with one Messages object', async () => {
  await withBridge(async ({ baseUrl, token }) => {
    const response = await realFetch(baseUrl + '/v1/messages?beta=true', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      // No `stream` key - exactly what the model-validation probe sends.
      body: JSON.stringify({
        model: 'gpt-6-astra',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    const body = await response.json();
    assert.equal(body.type, 'message');
    assert.equal(typeof body.usage?.input_tokens, 'number');
  });
});

test('a turn that asked to stream still streams', async () => {
  await withBridge(async ({ baseUrl, token }) => {
    const response = await realFetch(baseUrl + '/v1/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-6-astra', stream: true, messages: [{ role: 'user', content: 'Hi' }] }),
    });
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.match(await response.text(), /event: message_start/);
  });
});
