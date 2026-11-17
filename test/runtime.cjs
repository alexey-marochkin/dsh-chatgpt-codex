const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerHooks } = require('node:module');
const assert = require('node:assert/strict');
const runtime = path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh');

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/') || specifier.startsWith('@earendil-works/')) {
    return next(specifier, { ...context, parentURL: pathToFileURL(path.join(runtime, 'package.json')).href });
  }
  return next(specifier, context);
} });

// Проверяет настоящий адаптер DSH на синтетическом OAuth и подменённом HTTP без чтения личных токенов.
async function main() {
  const { Context } = await import('@deepseek-ai/cordis');

  const { credentialKey } = await import('@deepseek-ai/dsh-credentials');
  const ctx = new Context();
  const records = new Map([[credentialKey('chatgpt-codex', 'account'), { kind: 'grant', payload: { type: 'oauth', access: 'unused-legacy-token', expires: Date.now() + 3600000 } }]]);
  records.set(credentialKey('chatgpt-codex', 'limits'), { kind: 'grant', payload: { type: 'oauth', access: 'quota-only-token', refresh: 'quota-refresh', accountId: 'quota-account', expires: Date.now() + 3600000 } });
  const routes = new Map();
  ctx.provide('credentials', {
    async readRecord(key) { return records.get(key); },
    async modifyRecord(key, mutate) { const next = await mutate(records.get(key)); if (next !== undefined) records.set(key, next); return records.get(key); },
    async deleteRecord(key) { records.delete(key); }
  });
  ctx.provide('connection', { fetch: { register(route) { routes.set(route.path, route); } } });
  let adapter;
  let directory;
  let configured = {};
  let refuseSave = true;
  ctx.provide('llm', {
    registerAdapter(providers, value) { assert.deepEqual(providers, ['chatgpt-codex']); adapter = value; },
    registerConfigurableProviders(entries) { directory = entries; }
  });
  ctx.provide('settings', {
    configure() { return () => {}; },
    async mutate(namespace, operations) {
      assert.equal(namespace, 'chatgpt-codex');
      assert.deepEqual(operations, [{ op: 'set', path: ['providers', 'chatgpt-codex'], value: {} }]);
      if (refuseSave) throw new Error('TEST_SAVE_REFUSED');
      configured = { 'chatgpt-codex': {} };
    }
  });
  global.fetch = async (url, options) => {
    if (url === 'https://chatgpt.com/backend-api/wham/usage') {
      assert.equal(options.headers.Authorization, 'Bearer quota-only-token');
      assert.equal(options.headers['ChatGPT-Account-Id'], 'quota-account');
      return Response.json({ plan_type: 'pro', rate_limit: { primary_window: { used_percent: 58, limit_window_seconds: 604800, reset_at: 1900000000 } } });
    }
    assert.equal(String(url), 'https://chatgpt.com/backend-api/codex/models?client_version=1.3.0');
    assert.equal(options.headers.Authorization, 'Bearer quota-only-token');
    return Response.json({ models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' }] });
  };
  const plugin = await import(pathToFileURL(path.resolve(__dirname, '../index.js')));
  assert.deepEqual(plugin.Config({}).providers.get(), {});
  await plugin.apply(ctx, { providers: { get: () => configured } });
  assert.deepEqual(directory[0].settingsPath, ['providers', 'chatgpt-codex']);
  assert.equal(directory[0].displayName, 'ChatGPT - Codex');
  assert.deepEqual(await adapter.listModels(), []);
  const refreshed = await routes.get('/api/chatgpt-codex/refresh').fetch(new Request('http://localhost/api/chatgpt-codex/refresh', { method: 'POST' }));
  assert.equal(refreshed.status, 200);
  assert.deepEqual(configured, {});
  const requestApply = () => routes.get('/api/chatgpt-codex/apply').fetch(new Request('http://localhost/api/chatgpt-codex/apply', { method: 'POST' }));
  const refused = await requestApply();
  assert.equal(refused.status, 400);
  const refusal = await refused.json();
  assert.equal(refusal.error, 'SAVE_FAILED');
  assert.equal(refusal.status, 'connected');
  assert.equal(refusal.modelCount, 1);
  refuseSave = false;
  assert.equal((await requestApply()).status, 200);
  const models = await adapter.listModels();
  assert(models.some(model => model.provider === 'chatgpt-codex' && model.id === 'gpt-6.1-sol'));
  assert(!models.some(model => model.id === 'gpt-5.3-codex-spark'));
  const info = await adapter.resolveModel('chatgpt-codex', 'gpt-6.1-sol');
  assert.equal(info.provider, 'chatgpt-codex');
  const status = await routes.get('/api/chatgpt-codex/status').fetch(new Request('http://localhost/api/chatgpt-codex/status'));
  const text = await status.text();
  assert(!text.includes('quota-only-token'));
  assert(text.includes('connected'));
  const quota = await (await routes.get('/api/chatgpt-codex/quota').fetch(new Request('http://localhost/api/chatgpt-codex/quota'))).json();
  assert.equal(quota.data.weekly.remainingPercent, 42);
  assert(!JSON.stringify(quota).includes('quota-only-token'));
  await routes.get('/api/chatgpt-codex/logout').fetch(new Request('http://localhost/api/chatgpt-codex/logout', { method: 'POST' }));
  assert(!records.has(credentialKey('chatgpt-codex', 'limits')));
  assert(!records.has(credentialKey('chatgpt-codex', 'account')));
  assert.equal((await (await routes.get('/api/chatgpt-codex/quota').fetch(new Request('http://localhost/api/chatgpt-codex/quota'))).json()).status, 'signed-out');
  configured = {};
  assert.deepEqual(await adapter.listModels(), []);
  console.log('PASS: provider directory, add/remove configuration, account catalog, model metadata, shared model/quota credentials and unified logout and safe status');

}
main().catch(error => { console.error(error); process.exitCode = 1; });
