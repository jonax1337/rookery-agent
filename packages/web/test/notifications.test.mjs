import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

async function load(file) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('../src/' + file, import.meta.url))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
  });
  const module = { exports: {} };
  new Function('module', 'exports', outputFiles[0].text)(module, module.exports);
  return module.exports;
}

const lib = await load('lib/notifications.ts');

const base = { id: 'n1', orgId: 'o', kind: 'schedule', title: 'T', body: 'B', fromKind: 'system', createdAt: 1 };
const event = (id, kind, at) => ({ id, taskId: 't', at, kind, actorKind: 'agent', text: kind + ' ' + id });

test('a schedule notification links to its run, then its conversation', () => {
  const sources = lib.notificationSources({ ...base, cronJobId: 'job', cronRunId: 'run', sessionId: 's' });
  assert.deepEqual(
    sources.map((source) => source.to),
    ['/cron/job?run=run', '/c/s'],
  );
});

test('a task notification links to the card first', () => {
  const sources = lib.notificationSources({ ...base, kind: 'task', taskId: 'abc', sessionId: 's' });
  assert.equal(sources[0].to, '/tasks/abc');
});

test('only a question about a card offers an answer box', () => {
  assert.equal(lib.isAnswerable({ ...base, kind: 'question', taskId: 't' }), true);
  assert.equal(lib.isAnswerable({ ...base, kind: 'question' }), false);
  assert.equal(lib.isAnswerable({ ...base, kind: 'task', taskId: 't' }), false);
});

test('the open question is the newest one with no answer after it', () => {
  const events = [event('a', 'created', 1), event('b', 'question', 2), event('c', 'answer', 3), event('d', 'question', 4)];
  assert.equal(lib.openQuestion(events)?.id, 'd');
  assert.equal(lib.openQuestion(events.slice(0, 3)), null);
  assert.equal(lib.openQuestion([event('a', 'created', 1)]), null);
});

test('every kind has a label and a filter', () => {
  for (const kind of ['schedule', 'watch', 'task', 'question', 'agent', 'sleep', 'system']) {
    assert.ok(lib.NOTIFICATION_KIND_LABEL[kind]);
    assert.ok(lib.NOTIFICATION_FILTERS.some((filter) => filter.id === kind));
  }
});
