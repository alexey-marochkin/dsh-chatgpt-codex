import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Проверяет настоящий UI предупреждения без сети, таймеров и аккаунта пользователя.
async function fixture(fail = false) {
  const states = [], refs = [], effects = [], calls = [];
  let component, stateIndex, refIndex;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) { const index = stateIndex++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
    useRef(initial) { return refs[refIndex++] ??= { current: initial }; },
    useEffect(effect, deps) { if (deps.length === 4) effects.push(effect); },
    useLayoutEffect() {}
  };
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8').replace('return { apply, inject:', 'return { QuotaPanel, apply, inject:');
  vm.runInNewContext(source, {
    setTimeout() {}, clearTimeout() {}, document: { hidden: false, body: {}, addEventListener() {}, removeEventListener() {} },
    window: { __ModuleLoader__: { load: entry => { component = entry.factory(name => name === 'react' ? react : name === 'react-dom' ? { createPortal: child => child } : { Tooltip: 'tooltip' }).QuotaPanel; } } }
  });
  const send = async action => {
    calls.push(action);
    if (action === 'quota-reset-warnings') {
      if (fail) throw new Error('offline');
      return { warnings: [{ id: 'reset', expiresAt: Date.now() + 3600000 }] };
    }
    return { status: 'connected', fetchedAt: Date.now(), data: { weekly: { remainingPercent: 10 }, windows: [], resetsAvailable: 1 } };
  };
  const render = () => { stateIndex = 0; refIndex = 0; return component({ send, language: 'ru' }); };
  const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...node.children.flatMap(nodes)];
  render(); effects[0]();
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  return { calls, render, nodes };
}

test('предупреждение показывает срок, открывает список без расходования и закрывается', async () => {
  const f = await fixture();
  let tree = f.render();
  assert.match(JSON.stringify(tree), /Срок действия сброса истекает/);
  f.nodes(tree).find(node => node.children.includes('Посмотреть сбросы')).props.onClick();
  tree = f.render();
  assert(f.nodes(tree).some(node => node.type?.name === 'ResetDialog'));
  assert.deepEqual(f.calls, ['quota', 'quota-reset-warnings']);
  f.nodes(tree).find(node => node.props['aria-label'] === 'Закрыть предупреждение').props.onClick();
  assert.doesNotMatch(JSON.stringify(f.render()), /Срок действия сброса истекает/);
});

test('ошибка проверки сбросов не создаёт предупреждение и не скрывает свежую квоту', async () => {
  const f = await fixture(true);
  const tree = JSON.stringify(f.render());
  assert.doesNotMatch(tree, /Срок действия сброса истекает/);
  assert.match(tree, /10%/);
});
