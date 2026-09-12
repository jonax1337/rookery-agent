import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModels } from '../dist/providers/catalogue.js';

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
