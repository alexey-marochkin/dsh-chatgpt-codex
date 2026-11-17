import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { credentialStore, selectModels, beginLogin } from '../core.js';

// Подменяет внешние сервисы, сохраняя реальную оркестрацию входа и записи credentials.
async function setup(savedLimits = false) {
  const records = new Map(savedLimits ? [['chatgpt-codex/limits', { payload: { access: 'saved' } }]] : []);
  const routes = new Map();
  let finish, reject, logins = 0, resets = 0;
  const quota = { async reset() { resets++; }, async dispose() {} };
  const provider = { getModels: () => [], auth: { oauth: { login: () => { logins++; return new Promise((resolve, fail) => { finish = resolve; reject = fail; }); } } } };
  const context = {
    credentialStore, selectModels, beginLogin, randomUUID, AbortController, AbortSignal, setTimeout, clearTimeout, URL, Response,
    credentialKey: (provider, key) => `${provider}/${key}`,
    openaiCodexProvider: () => provider, createQuota: async () => quota, createResets: () => ({ cancel: async () => {} }),
    createModels: () => ({ setProvider() {}, getAuth: async () => ({ auth: { apiKey: 'model-token' } }) }),
    attributionHeaders: () => ({}), fetch: async () => Response.json({ models: [] }),
    LlmAdapter: class {}, PiAiAdapter: class {}, createJournal: () => ({ write() {}, flush() {} }), settingsDiagnostic: () => 'error'
  };
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export const Config =.*;\r?\n/gm, '').replace(/export /g, '');
  vm.runInNewContext(source + '\nthis.run = apply;', context);
  await context.run({
    get() {}, on() {}, emit() {}, effect() {},
    credentials: { readRecord: async key => records.get(key), modifyRecord: async (key, mutate) => { const next = await mutate(records.get(key)); if (next !== undefined) records.set(key, next); return records.get(key); }, deleteRecord: async key => records.delete(key) },
    llm: { registerConfigurableProviders() {}, registerAdapter() {} },
    connection: { fetch: { register: route => routes.set(route.path, route) } }
  }, { providers: { get: () => ({}) } });
  const call = action => routes.get(`/api/chatgpt-codex/${action}`).fetch(new Request(`http://localhost/${action}`, { method: 'POST' }));
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
  return { call, settle, records, count: () => logins, resets: () => resets, finish: () => finish({ type: 'oauth', access: 'new', refresh: 'refresh', accountId: 'account', expires: Date.now() + 3600000 }), fail: () => reject(new Error('denied')) };
}

test('один OAuth сохраняет общую авторизацию и сбрасывает кэш лимитов', async () => {
  for (const saved of [false, true]) {
    const flow = await setup(saved);
    await flow.call('login'); await flow.settle(); flow.finish(); await flow.settle();
    assert.equal(flow.records.get('chatgpt-codex/limits').payload.access, 'new');
    assert(!flow.records.has('chatgpt-codex/account'));
    assert.equal(flow.count(), 1);
    assert.equal(flow.resets(), 1);
  }
});

test('ошибка и отмена общего входа не сохраняют поздний результат', async () => {
  for (const cancel of [false, true]) {
    const flow = await setup();
    await flow.call('login'); await flow.settle();
    if (cancel) { const cancelled = flow.call('cancel'); flow.finish(); await cancelled; }
    else flow.fail();
    await flow.settle();
    assert.equal(flow.count(), 1);
    assert.equal(flow.resets(), 0);
    assert(!flow.records.has('chatgpt-codex/limits'));
  }
});
