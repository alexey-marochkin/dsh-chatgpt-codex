import { withExperimentalModels, catalogRows, speedProvider } from '../catalog.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { credentialStore, selectModels, beginLogin } from '../core.js';
import { createCatalogCache } from '../catalog-cache.js';
import { createResetWarnings } from '../reset-warnings.js';

const catalog = { models: [{ slug: 'model', visibility: 'list', display_name: 'Model' }] };

// Запускает реальный коннектор с временным диском и подменёнными сетью, DSH и авторизацией.
async function start(directory, fetch, accountId = 'account') {
  let grant = accountId ? { accountId, access: 'test-token' } : undefined;
  let adapter;
  const configuration = { 'chatgpt-codex': { speeds: {}, reasoningDefaults: {} } };
  const routes = new Map();
  const provider = { getModels: () => [{ id: 'model', reasoning: true }], auth: { oauth: {} } };
  const context = {
    withExperimentalModels, catalogRows, speedProvider, credentialStore, selectModels, beginLogin, createCatalogCache, createResetWarnings, randomUUID,
    AbortController, AbortSignal, setTimeout, clearTimeout, URL, Response, fetch,
    credentialKey: (provider, key) => `${provider}/${key}`,
    openaiCodexProvider: () => provider,
    createQuota: async () => ({ logout: async () => { grant = undefined; }, dispose() {} }),
    createResets: () => ({ cancel: async () => {} }),
    createModels: () => ({ setProvider() {}, getAuth: async () => ({ auth: { apiKey: 'test-token' } }) }),
    LlmAdapter: class {},
    PiAiAdapter: class {
      constructor(options) { this.options = options; }
      stream(options) { return options; }
      async resolveModel() { return { id:'model', reasoning:{ efforts:[{id:'low'},{id:'high'}] } }; }
      async prepareCall() { return { model: await this.resolveModel(), stream: options => options }; }
      async listModels() { return this.options.profiles().get('openai-codex').piProvider.getModels(); }
    },
    createJournal: () => ({ write() {}, flush() {} }), settingsDiagnostic: () => 'error'
  };
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export const Config =.*;\r?\n/gm, '').replace(/export /g, '');
  vm.runInNewContext(source + '\nthis.run = apply;', context);
  await context.run({
    get: name => name === 'dshHomePath' ? (...parts) => join(directory, ...parts) : undefined,
    on() {}, emit() {}, effect() {}, inject() {},
    settings: { mutate: async (_ns, changes) => { for (const change of changes) configuration['chatgpt-codex'][change.path[2]][change.path[3]] = change.value; } },
    credentials: { readRecord: async () => grant ? { payload: grant } : undefined, deleteRecord: async () => {} },
    llm: { registerConfigurableProviders() {}, registerAdapter: (_, value) => { adapter = value; } },
    connection: { fetch: { register: route => routes.set(route.path, route) } }
  }, { providers: { get: () => configuration } });
  return { adapter, call: (action, body) => routes.get(`/api/chatgpt-codex/${action}`).fetch(new Request(`http://localhost/${action}`, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) })) };
}

// Освобождает временный профиль после проверки, не затрагивая установленный DSH.
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-catalog-flow-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('после перезапуска кэш доступен до завершения сети и сохраняется при сбое', async t => {
  const dir = await directory(t);
  const first = await start(dir, async () => Response.json(catalog));
  assert.equal((await first.adapter.listModels())[0].id, 'model');
  let reject;
  const pending = new Promise((_, fail) => { reject = fail; });
  const restarted = await start(dir, () => pending);
  assert.equal((await restarted.adapter.listModels())[0].id, 'model');
  reject(new Error('offline'));
  await restarted.call('refresh');
  assert.equal((await restarted.adapter.listModels())[0].id, 'model');
  await restarted.call('logout');
  assert.equal((await restarted.adapter.listModels()).length, 0);
  assert.equal(await createCatalogCache(join(dir, 'cache/chatgpt-codex/catalog.json')).read('account'), null);
});

test('чужой, просроченный и неавторизованный каталог не попадает в модели', async t => {
  const dir = await directory(t);
  const file = join(dir, 'cache/chatgpt-codex/catalog.json');
  await createCatalogCache(file).save('account', catalog);
  const offline = async () => { throw new Error('offline'); };
  for (const account of ['other', null]) {
    const app = await start(dir, offline, account);
    assert.equal((await app.adapter.listModels()).length, 0);
  }
  const data = JSON.parse(await readFile(file, 'utf8'));
  data.fetchedAt = Date.now() - 86400000;
  await writeFile(file, JSON.stringify(data));
  const app = await start(dir, offline);
  assert.equal((await app.adapter.listModels()).length, 0);
});

test('успешный пустой каталог заменяет старый кэш, а не возвращает удалённую модель', async t => {
  const dir = await directory(t);
  const file = join(dir, 'cache/chatgpt-codex/catalog.json');
  await createCatalogCache(file).save('account', catalog);
  const app = await start(dir, async () => Response.json({ models: [] }));
  await app.call('refresh');
  assert.equal((await app.adapter.listModels()).length, 0);
  assert.deepEqual((await createCatalogCache(file).read('account')).models, []);
});

test('выход во время обновления не позволяет позднему ответу восстановить кэш', async t => {
  const dir = await directory(t);
  const file = join(dir, 'cache/chatgpt-codex/catalog.json');
  await createCatalogCache(file).save('account', catalog);
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const app = await start(dir, () => response);
  await app.adapter.listModels();
  const logout = app.call('logout');
  finish(Response.json(catalog));
  await logout;
  assert.equal((await app.adapter.listModels()).length, 0);
  assert.equal(await createCatalogCache(file).read('account'), null);
});


test('диагностика показывает неизвестную модель, ошибку и источник после перезапуска', async t => {
  const dir = await directory(t);
  const app = await start(dir, async () => Response.json({ models: [...catalog.models, {slug:'new-model',visibility:'list'}] }));
  let state = await (await app.call('refresh')).json();
  assert.equal(state.catalog.source, 'network');
  assert.equal(state.catalog.rows.find(row => row.id === 'new-model').supported, false);
  const restarted = await start(dir, async () => new Response('', {status:503}));
  state = await (await restarted.call('refresh')).json();
  assert.equal(state.catalog.source, 'cache');
  assert.equal(state.catalog.error, 'CATALOG_HTTP_503');
  assert.equal(state.catalog.rows.length, 2);
  state = await (await restarted.call('logout')).json();
  assert.deepEqual(state.catalog.rows, []);
});

test('настройка скорости принимает только режим доступной поддерживаемой модели', async t => {
  const app = await start(await directory(t), async () => Response.json({models:[{slug:'model', visibility:'list', service_tiers:[{id:'priority'}]}]}));
  await app.call('refresh');
  assert.equal((await app.call('speed', {model:'model',tier:'ultrafast'})).status, 400);
  assert.equal((await app.call('speed', {model:'other',tier:'priority'})).status, 400);
  const result = await (await app.call('speed', {model:'model',tier:'priority'})).json();
  assert.equal(result.speeds.model, 'priority');
});


test('уровень по умолчанию действует в обоих путях запроса, явный выбор чата важнее', async t => {
  const app = await start(await directory(t), async () => Response.json({models:[{slug:'model',visibility:'list',supported_reasoning_levels:[{effort:'low'},{effort:'high'}]}]}));
  await app.call('refresh');
  assert.equal((await app.call('reasoning-default', {model:'model',tier:'max'})).status, 400);
  assert.equal((await app.call('reasoning-default', {model:'model',tier:'high'})).status, 200);
  assert.equal(app.adapter.stream({model:'model'}).reasoningEffort, 'high');
  const prepared = await app.adapter.prepareCall('chatgpt-codex','model');
  assert.equal((await app.adapter.resolveModel('chatgpt-codex','model')).reasoning.defaultEffort, 'high');
  assert.equal(prepared.model.reasoning.defaultEffort, 'high');
  assert.equal(prepared.stream({}).reasoningEffort, 'high');
  assert.equal(prepared.stream({reasoningEffort:'low'}).reasoningEffort, 'low');
  await app.call('reasoning-default', {model:'model',tier:'default'});
  assert.equal(app.adapter.stream({model:'model'}).reasoningEffort, undefined);
});
