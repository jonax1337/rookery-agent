import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModels } from '../dist/providers/catalogue.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_PROFILE, PROVIDER_CATALOG, providerContextWindow } from '../dist/providers/provider-catalog.js';

test('catalogues retain provider selectors and versioned names without static fallback', () => {
  assert.deepEqual(parseModels('claude', [{ value: 'new-family[1m]', displayName: 'New family', description: 'New family 12.3 · Provider description' }]), [
    { id: 'new-family[1m]', name: 'New family 12.3', description: 'New family 12.3 · Provider description', isDefault: false },
  ]);
  assert.equal(parseModels('codex', [{ model: 'new-id', displayName: 'New name', isDefault: true }])[0].name, 'New name');
  assert.deepEqual(parseModels('claude', []), []);
  assert.deepEqual(parseModels('codex', [null, {}, { model: 123 }]), []);
  assert.throws(() => parseModels('claude', undefined), /catalogue/);
});


test('Claude resolves its default to a real selectable model without a duplicate entry', () => {
  const rows = [
    { value: 'default', resolvedModel: 'future-model-9', description: 'Future 9 · Recommended' },
    { value: 'future', resolvedModel: 'future-model-9', description: 'Future 9 · Fast' },
    { value: 'other', resolvedModel: 'other-model', displayName: 'Other' },
  ];
  const models = parseModels('claude', rows);
  assert.equal(models.length, 2);
  assert.equal(models.find((model) => model.isDefault).id, 'future');
  assert.ok(models.every((model) => model.id !== 'default'));
  assert.equal(parseModels('claude', [rows[0]])[0].id, 'future-model-9');
});

test('ChatGPT context uses each model maximum, falling back for older catalogues', () => {
  const home = mkdtempSync(join(tmpdir(), 'rookery-context-'));
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    writeFileSync(join(home, 'models_cache.json'), JSON.stringify({
      models: [
        { slug: 'large', context_window: 272000, max_context_window: 872000 },
        { slug: 'legacy', context_window: 200000 },
        { slug: 'maximum-only', max_context_window: 400000 },
      ],
    }));
    assert.equal(providerContextWindow(CODEX_PROFILE, 'large'), 872000);
    assert.equal(providerContextWindow(CODEX_PROFILE, 'legacy'), 200000);
    assert.equal(providerContextWindow(CODEX_PROFILE, 'maximum-only'), 400000);
    assert.equal(providerContextWindow(CODEX_PROFILE, 'unknown'), undefined);
    writeFileSync(join(home, 'models_cache.json'), JSON.stringify({
      models: [{ slug: 'large', context_window: 272000, max_context_window: 900000 }],
    }));
    assert.equal(providerContextWindow(CODEX_PROFILE, 'large'), 900000);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('provider context selects the model on the matching endpoint without guessing unknown limits', () => {
  const glm = PROVIDER_CATALOG.find((entry) => entry.id === 'glm');
  const profile = { ...glm, id: 'my-zai', defaultModel: 'glm-5.3' };
  assert.equal(providerContextWindow(profile), 1000000);
  assert.equal(providerContextWindow(profile, 'glm-5.3-flash'), 1000000);
  assert.equal(providerContextWindow(profile, 'unknown'), undefined);
  assert.equal(providerContextWindow({ ...profile, baseUrl: 'https://another.example' }), undefined);
  assert.equal(providerContextWindow({ id: 'claude', baseUrl: '' }, 'opus'), undefined);
});
