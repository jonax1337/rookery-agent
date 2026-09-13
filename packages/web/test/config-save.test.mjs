import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// Execute the production callbacks without mounting the provider's socket/runtime.
function callback(file, name, bindings) {
  const source = ts.createSourceFile(file, readFileSync(new URL('../src/' + file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      expression = (ts.isCallExpression(node.initializer)
        ? node.initializer.arguments[0]
        : node.initializer).getText(source);
    }
    ts.forEachChild(node, visit);
  }
visit(source);
  assert.ok(expression, `${file}: ${name} exists`);
  const js = ts.transpileModule(`const run = ${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(bindings), js + '\nreturn run;')(...Object.values(bindings));
}

for (const succeeds of [false, true]) {
  test(`provider returns ${succeeds} and reports the matching outcome`, async () => {
    const config = { assistantName: 'Saved' };
    const notifications = [];
    let published;
    const toast = (message) => notifications.push(['success', message]);
    toast.error = (message) => notifications.push(['error', message]);
    const save = callback('providers/rookery-provider.tsx', 'saveConfig', {
      api: { updateConfig: async (patch) => {
        assert.equal(patch, config);
        if (!succeeds) throw new Error('Offline');
        return config;
      } },
      setConfig: (value) => { published = value; },
      toast,
    });
    assert.equal(await save(config), succeeds);
    assert.equal(published, succeeds ? config : undefined);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0][0], succeeds ? 'success' : 'error');
  });
}

for (const page of ['SettingsPage', 'GatewayDetailPage']) {
  for (const succeeds of [false, true]) {
    for (const editDuringSave of [false, true]) {
      test(`${page}: success=${succeeds}, edit during save=${editDuringSave}`, async () => {
        const pending = { name: 'Submitted' };
        const draftRef = { current: pending };
        const touched = { current: true };
        const saving = [];
        let refreshed = 0;
        let finish;
        const saveResult = new Promise((resolve) => { finish = resolve; });
        const submit = callback(`pages/${page}.tsx`, 'submit', {
          draftRef, touched,
          setSaving: (value) => saving.push(value),
          save: async (patch) => {
            assert.equal(page === 'SettingsPage' ? patch : patch.gateways.telegram, pending);
            return saveResult;
          },
          refresh: async () => { refreshed += 1; },
          toast: () => assert.fail('Provider owns the save notification'),
          reportFailure: () => assert.fail('Boolean failure must not throw'),
        });
        const operation = submit();
        const newer = { name: 'Still editing' };
        if (editDuringSave) draftRef.current = newer;
        finish(succeeds);
        await operation;
        assert.equal(touched.current, !succeeds || editDuringSave);
        assert.equal(draftRef.current, editDuringSave ? newer : pending);
        assert.deepEqual(saving, [true, false]);
        assert.equal(refreshed, page === 'GatewayDetailPage' && succeeds ? 1 : 0);
      });
    }
  }
}

for (const connected of [false, true]) {
  test(`form focuses validation error only while still mounted: ${connected}`, async () => {
    let focused = false;
    let scheduled;
    let prevented = false;
    let validated = false;
    const submit = callback('components/blocks/form-page.tsx', 'handleSubmit', {
      onSubmit: async () => { validated = true; },
      requestAnimationFrame: (fn) => { scheduled = fn; },
    });
    await submit({
      preventDefault: () => { prevented = true; },
      currentTarget: {
        isConnected: connected,
        querySelector: (selector) => {
          assert.equal(selector, '[aria-invalid="true"]');
          assert.equal(validated, true);
          return { focus: () => { focused = true; } };
        },
      },
    });
    assert.equal(prevented, true);
    scheduled();
    assert.equal(focused, connected);
  });
}

test('bulk confirmations use English verb-first titles', () => {
  const titleFor = (rows, verb, plural) => callback(
    'components/common/confirm-dialog.tsx',
    'title',
    {
      rows,
      first: rows[0],
      noun: { singular: 'task', plural },
      nameOf: (row) => row.name,
      verb,
      formatNumber: String,
    },
  );

  assert.equal(titleFor([{ name: 'Research' }], 'archive', 'Agents'), 'Archive “Research”?');
  assert.equal(titleFor([{ name: 'One' }, { name: 'Two' }], 'cancel', 'Tasks'), 'Cancel 2 tasks?');
});

for (const fails of [false, true]) {
  test(`shared form prevents duplicate writes and permits retry after ${fails ? 'failure' : 'success'}`, async () => {
    const inFlight = { current: false };
    const saving = [];
    const failures = [];
    let writes = 0;
    let finish;
    const pending = new Promise((resolve, reject) => {
      finish = () => fails ? reject(new Error('Offline')) : resolve();
    });
    const submit = callback('components/forms/form-kit.tsx', 'submit', {
      inFlight,
      draftRef: { current: 'draft' },
      schemaRef: { current: { safeParse: (data) => ({ success: true, data }) } },
      runRef: { current: async (parsed) => {
        assert.equal(parsed, 'draft');
        writes += 1;
        if (writes === 1) await pending;
      } },
      setErrors: () => {},
      setFailure: (value) => failures.push(value),
      setSaving: (value) => saving.push(value),
      failureMessage: (error) => error.message,
    });
    const first = submit();
    await submit();
    assert.equal(writes, 1);
    assert.equal(inFlight.current, true);
    finish();
    await first;
    assert.equal(inFlight.current, false);
    assert.deepEqual(failures, fails ? [null, 'Offline'] : [null]);
    await submit();
    assert.equal(writes, 2);
    assert.deepEqual(saving, [true, false, true, false]);
  });
}
