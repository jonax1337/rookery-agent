import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

test('page navigation resets the shared scroller while query-only filtering keeps its position', async () => {
  const require = createRequire(import.meta.url);
  let location = { pathname: '/settings/voice', search: '' };
  let dependencies;
  let position = 250;
  const scrollRef = { current: { scrollTo: (x, y) => {
    assert.equal(x, 0);
    position = y;
  } } };
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('../src/components/blocks/page-body.tsx', import.meta.url))],
    alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
  });
  const module = { exports: {} };
  const mockedRequire = (id) => {
    if (id === 'react-router') return { useLocation: () => location };
    if (id === 'react') return {
      ...require('react'),
      useRef: () => scrollRef,
      useLayoutEffect: (effect, next) => {
        if (!dependencies || next.some((value, i) => value !== dependencies[i])) effect();
        dependencies = next;
      },
    };
    return require(id);
  };
  new Function('require', 'module', 'exports', outputFiles[0].text)(mockedRequire, module, module.exports);
  const render = () => module.exports.PageBody({ children: 'Content' });
  assert.equal(render().props.ref, scrollRef);
  assert.equal(position, 0);
  position = 400;
  location = { pathname: '/settings/identity', search: '' };
  render();
  assert.equal(position, 0, 'a different screen begins at the top');
  position = 120;
  location = { ...location, search: '?filter=example' };
  render();
  assert.equal(position, 120, 'filter changes do not jump back to the top');
});
