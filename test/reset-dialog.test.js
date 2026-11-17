import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Запускает обработчики настоящего диалога с подменённым транспортом и управляемыми React hooks.
function fixture(historyFails = false) {
  const states = [], refs = [], effects = [], calls = [];
  let component, stateIndex, refIndex, closed = 0, refreshed = 0;
  const details = { available: 1, credits: [
    { id: 'available', type: 'codex_rate_limits', status: 'available', expiresAt: Date.parse('2099-01-01') },
    { id: 'used', type: 'codex_rate_limits', status: 'redeemed', expiresAt: null }
  ] };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) { const index = stateIndex++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = value; }]; },
    useRef(initial) { const index = refIndex++; return refs[index] ??= { current: initial }; },
    useEffect(effect) { if (!effects.length) effects.push(effect); }
  };
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8').replace("return { apply, inject:", "return { ResetDialog, apply, inject:");
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: entry => { component = entry.factory(name => name === 'react' ? react : {}).ResetDialog; } } } });
  const send = async (action, body) => {
    calls.push({ action, body });
    if (action === 'quota-reset-history') {
      if (historyFails) throw new Error('HTTP_503');
      return { windowStart: Date.parse('2026-10-17'), asOf: Date.parse('2026-11-16'), events: [
        { id: 'event-1', kind: 'granted', occurredAt: Date.parse('2026-11-13') },
        { id: 'event-2', kind: 'used', occurredAt: Date.parse('2026-11-06') }
      ] };
    }
    return action === 'quota-resets' ? details : { code: 'reset' };
  };
  const render = () => { stateIndex = 0; refIndex = 0; return component({ send, language: 'ru', onClose: () => { closed++; }, onChanged: async () => { refreshed++; } }); };
  const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...node.children.flatMap(nodes)];
  const button = (tree, label) => nodes(tree).find(item => item.type === 'button' && item.children.some(child => child === label));
  const mount = async () => { render(); effects[0](); await new Promise(resolve => setImmediate(resolve)); return render(); };
  return { render, mount, calls, button, nodes, closed: () => closed, refreshed: () => refreshed };
}

test('открытие, первая кнопка, отмена и история никогда не расходуют сброс', async () => {
  const f = fixture();
  let tree = await f.mount();
  assert.equal(f.calls[0].action, 'quota-resets');
  assert.match(JSON.stringify(tree), /Срок действия истекает/);
  f.button(tree, 'Использовать сброс').props.onClick();
  tree = f.render();
  assert(f.button(tree, 'Подтвердить'));
  assert.match(JSON.stringify(tree), /Будет использован один сброс/);
  f.button(tree, 'Отмена').props.onClick();
  tree = f.render();
  assert(!f.button(tree, 'Подтвердить'));
  await f.button(tree, 'История').props.onClick();
  tree = f.render();
  assert.match(JSON.stringify(tree), /Сброс использован/);
  assert.match(JSON.stringify(tree), /Получен сброс лимита/);
  assert.match(JSON.stringify(tree), /Последние 30 дней/);
  assert(!f.button(tree, 'Использовать сброс'));
  tree.props.onCancel({ preventDefault() {} });
  assert.equal(f.closed(), 1);
  assert.deepEqual(f.calls.map(item => item.action), ['quota-resets', 'quota-reset-history']);
});

test('ошибка истории показывает повтор, не пустой журнал и не блокирует доступные сбросы', async () => {
  const f = fixture(true);
  await f.button(await f.mount(), 'История').props.onClick();
  let tree = f.render();
  assert.match(JSON.stringify(tree), /Не удалось загрузить историю/);
  assert.doesNotMatch(JSON.stringify(tree), /событий нет/);
  assert(f.button(tree, 'Повторить'));
  await f.button(tree, 'Доступно 1').props.onClick();
  tree = f.render();
  assert(f.button(tree, 'Использовать сброс'));
});

test('только подтверждение отправляет выбранный сброс один раз и затем обновляет список и лимиты', async () => {
  const f = fixture();
  f.button(await f.mount(), 'Использовать сброс').props.onClick();
  const confirm = f.button(f.render(), 'Подтвердить');
  await Promise.all([confirm.props.onClick(), confirm.props.onClick()]);
  const writes = f.calls.filter(item => item.action === 'quota-reset-use');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.creditId, 'available');
  assert.equal(writes[0].body.confirmed, true);
  assert.equal(f.calls.at(-1).action, 'quota-resets');
  assert.equal(f.refreshed(), 1);
  assert.match(JSON.stringify(f.render()), /Лимиты сброшены/);
});
