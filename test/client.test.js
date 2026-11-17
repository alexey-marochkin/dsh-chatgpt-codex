import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Монтирует регистрацию карточки с управляемым состоянием, не обращаясь к аккаунту пользователя.
function renderCard(status, hasCredential) {
  let plugin;
  let registration;
  let component;
  let stateIndex = 0;
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [stateIndex++ === 0 ? { status, modelCount: 1, hasCredential } : stateIndex === 4 ? {} : initial, () => {}],
    useRef: () => ({ current: null }),
    useEffect() {},
    useLayoutEffect() {}
  };
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: entry => {
      plugin = entry.factory(name => name === 'react' ? react : { createPortal: child => ({ portal: child }) });
    } } }
  });
  plugin.apply({ effect() {}, inject() {}, slots: {
    inject(name, callback) { assert.equal(name, 'settings.models.provider-card'); callback(); },
    register(options, panel) { registration = options; component = panel; }
  } });
  const tree = component({ send() {}, language: 'ru', configured: true });
  return { registration, tree, rendered: JSON.stringify(tree) };
}

test('карточка регистрируется в выборе поставщика, а не в нижнем блоке страницы', () => {
  const { registration } = renderCard('signed-out');
  assert.equal(registration.name, 'settings.models.provider-card');
  assert.equal(registration.key, 'chatgpt-codex');
});

test('кнопка авторизации переключается между входом, выходом и отменой', () => {
  for (const [status, credential, expected] of [
    ['signed-out', false, 'Войти через ChatGPT'], ['connected', true, 'Отключить'],
    ['stored', true, 'Отключить'], ['error', true, 'Отключить'], ['error', false, 'Войти через ChatGPT'],
    ['signing-in', false, 'Отменить вход'], ['loading', undefined, 'Войти через ChatGPT']
  ]) {
    const { tree } = renderCard(status, credential);
    const actions = tree.children.find(child => child?.type === 'div').children.filter(child => child?.type === 'button');
    const auth = actions.filter(child => ['Войти через ChatGPT', 'Отключить', 'Отменить вход'].includes(child.children[0]));
    assert.equal(auth.length, 1);
    assert.equal(auth[0].children[0], expected);
    assert.equal(auth[0].props.disabled, status === 'loading');
  }
});

test('нажатие входа открывает браузер после получения адреса, без повторного открытия при опросе', async () => {
  let plugin, panel, stateIndex, refIndex;
  const states = [], refs = [], effects = [], opened = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) { const index = stateIndex++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = value; }]; },
    useRef(initial) { const index = refIndex++; return refs[index] ??= { current: initial }; },
    useEffect(effect, deps) { if (deps?.length === 2 && typeof deps[0] === 'string') effects.push(effect); },
    useLayoutEffect() {}
  };
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { open: (...args) => opened.push(args), __ModuleLoader__: { load: entry => { plugin = entry.factory(name => name === 'react' ? react : { createPortal: child => child }); } } }
  });
  plugin.apply({ effect() {}, inject() {}, slots: { inject: (_, fn) => fn(), register: (_, component) => { panel = component; } } });
  const render = () => {
    stateIndex = 0; refIndex = 0;
    const tree = panel({ language: 'ru', send: async () => ({ status: 'signing-in' }) });
    effects.splice(0).forEach(effect => effect());
    return tree;
  };
  states[0] = { status: 'signed-out', hasCredential: false };
  const initial = render();
  const login = initial.children.find(child => child?.type === 'div').children.find(child => child?.children?.includes('Войти через ChatGPT'));
  await login.props.onClick();
  render();
  assert.equal(opened.length, 0);
  states[0] = { status: 'signing-in', url: 'https://auth.openai.com/test' };
  const waiting = render();
  render();
  assert.deepEqual(opened, [['https://auth.openai.com/test', '_blank', 'noopener,noreferrer']]);
  assert.doesNotMatch(JSON.stringify(waiting), /"href":"https:\/\/auth.openai.com|Открыть страницу входа|Открыть браузер/);
});

test('индикатор монтируется только для моделей нашего коннектора, включая переключение поставщика', () => {
  let plugin, dock;
  let current = { provider: 'chatgpt-codex', model: 'gpt-6-astra' };
  const react = { createElement: (type, props) => ({ type, props }), useSyncExternalStore: (_, snapshot) => snapshot() };
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: entry => { plugin = entry.factory(name => name === 'react' ? react : {}); } } }
  });
  const scope = { modelDirectories: {}, slots: { inject: (_, fn) => fn(), register: (options, component) => { dock = component; assert.equal(options.name, 'conversation.composer.dock'); } } };
  plugin.apply({ effect() {}, slots: { inject() {} }, inject: (_, fn) => fn(scope) });
  const props = { directory: { getSnapshot: () => ({ current }) }, send() {}, language: 'ru' };
  assert(dock(props));
  for (const provider of ['deepseek', 'openai-codex', 'openai']) {
    current = { provider, model: 'gpt-6-astra' };
    assert.equal(dock(props), null);
  }
  current = null;
  assert.equal(dock(props), null);
  current = { provider: 'chatgpt-codex', model: 'gpt-6.1-sol' };
  assert(dock(props));
});

test('подтверждённый вход показывает зелёную точку и подпись в строке поставщика', () => {
  const { rendered } = renderCard('connected');
  assert.match(rendered, /Вошёл в систему/);
  assert.match(rendered, /portal/);
  assert.match(rendered, /--dsw-alias-state-success-primary/);
});

test('сохранённый токен и отсутствие входа не показывают подтверждённый зелёный статус', () => {
  for (const status of ['signed-out', 'stored', 'error']) {
    const { rendered } = renderCard(status);
    assert.doesNotMatch(rendered, /Вошёл в систему|--dsw-alias-state-success-primary/);
  }
});

test('Применить доступна после входа и при восстановлении сохранённой авторизации', () => {
  for (const status of ['signed-out', 'stored', 'connected']) {
    const { tree } = renderCard(status);
    const apply = tree.children.find(child => child?.type === 'button' && child.children.includes('Применить'));
    assert(apply);
    assert.equal(apply.props.disabled, status === 'signed-out');
  }
});

// Рендерит лимиты с фиксированным состоянием, не запуская опрос и авторизацию.
function renderQuota(state, settings) {
  let plugin, dock, index = 0;
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useSyncExternalStore: (_, snapshot) => snapshot(),
    useState: initial => [index++ === 0 ? state : index === 2 ? true : initial, () => {}],
    useRef: () => ({ current: null }), useEffect() {}, useLayoutEffect() {}
  };
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    document: { body: {} },
    window: { __ModuleLoader__: { load: entry => { plugin = entry.factory(name => name === 'react' ? react : name === 'react-dom' ? { createPortal: child => child } : { Tooltip: 'tooltip' }); } } }
  });
  const scope = { slots: { inject: (_, fn) => fn(), register: (_, component) => { dock = component; } } };
  plugin.apply({ effect() {}, slots: { inject() {} }, inject: (_, fn) => fn(scope) });
  const props = { directory: { getSnapshot: () => ({ current: { provider: 'chatgpt-codex' } }) }, send() {}, language: 'ru', settings };
  return JSON.stringify(dock(props).type(props));
}

test('панель индикатора не содержит управление входом даже во время авторизации', () => {
  for (const status of ['signed-out', 'signing-in', 'error', 'connected']) {
    const rendered = renderQuota({ status, url: 'https://auth.openai.com/test' }, false);
    assert.doesNotMatch(rendered, /Подключить лимиты|Отключить лимиты|Открыть страницу входа|auth.openai.com|quota-actions|password/);
    assert.match(rendered, /Настройки → Модели/);
  }
});

test('настройки используют общий вход без второй авторизации лимитов', () => {
  const rendered = renderQuota({ status: 'signed-out' }, true);
  assert.match(rendered, /Войдите в ChatGPT/);
  assert.match(rendered, /"type":"svg"/);
  assert.doesNotMatch(rendered, /общий вход|один вход|share one/);
  assert.match(rendered, /Обновить лимиты/);
  assert.doesNotMatch(rendered, /Подключить лимиты|Отключить лимиты|Войти в лимиты|второй шаг/);
});
