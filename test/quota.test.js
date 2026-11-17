import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuota, createQuota } from '../quota.js';

const window = (used, seconds = 604800) => ({ used_percent: used, limit_window_seconds: seconds, reset_at: 1900000000 });
const payload = { plan_type: 'pro', rate_limit: { primary_window: window(58), secondary_window: null }, additional_rate_limits: [{ limit_name: 'Extra model', metered_feature: 'extra', rate_limit: { primary_window: window(25, 18000) } }], credits: { balance: '0', unlimited: false }, rate_limit_reset_credits: { available_count: 3 } };

test('неделя определяется длительностью, все окна сохраняются; отсутствующее окно не становится 100%', () => {
  const result = normalizeQuota(payload);
  assert.equal(result.weekly.remainingPercent, 42);
  assert.equal(result.windows.length, 2);
  assert.equal(result.resetsAvailable, 3);
  assert.equal(normalizeQuota({ plan_type: 'plus', rate_limit: { primary_window: window(10, 18000) } }).weekly, null);
  assert.equal(normalizeQuota({ rate_limit: { primary_window: window(null) } }).windows.length, 0);
  assert.equal(normalizeQuota({ rate_limit: { secondary_window: window(100) } }).weekly.remainingPercent, 0);
  assert.equal(normalizeQuota({ rate_limit: { secondary_window: window(110) } }).weekly.remainingPercent, 0);
  assert.throws(() => normalizeQuota({ error: 'bad' }), /INVALID_QUOTA/);
});

// Создаёт отдельное хранилище и контролируемый HTTP для проверки жизненного цикла лимитов.
async function fixture(overrides = {}) {
  let grant = { type: 'oauth', access: 'private-access', refresh: 'private-refresh', accountId: 'test-account', expires: Date.now() + 3600000 };
  let calls = 0;
  const credentials = { read: async () => grant, modify: async (_, mutate) => { grant = await mutate(grant) ?? grant; return grant; }, delete: async () => { grant = undefined; } };
  const quota = await createQuota({ credentials, oauth: {}, journal: { write() {} }, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(options.headers.Authorization, 'Bearer private-access');
    assert.equal(options.headers['ChatGPT-Account-Id'], 'test-account');
    assert.equal(options.redirect, 'error');
    return Response.json(payload);
  }, ...overrides });
  return { quota, calls: () => calls, grant: () => grant };
}

test('чтение кэшируется, секреты не выходят в UI, выход очищает результат', async () => {
  const { quota, calls, grant } = await fixture();
  const [a, b] = await Promise.all([quota.read(), quota.read()]);
  assert.equal(a.status, 'connected');
  assert.deepEqual(a, b);
  assert.equal(calls(), 1);
  await quota.read();
  assert.equal(calls(), 1);
  assert.doesNotMatch(JSON.stringify(a), /private-access|private-refresh/);
  await quota.logout();
  assert.equal(grant(), undefined);
  assert.deepEqual(await quota.read(), { status: 'signed-out' });
});

test('ошибка обновления помечает сохранённые данные устаревшими', async () => {
  let fail = false;
  const { quota } = await fixture({ fetchImpl: async () => { if (fail) throw new Error('secret server text'); return Response.json(payload); } });
  await quota.read();
  fail = true;
  const result = await quota.read(true);
  assert.equal(result.status, 'error');
  assert.equal(result.data.weekly.remainingPercent, 42);
  assert.equal(result.error, 'QUOTA_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /secret server/);
});

test('новый общий вход сбрасывает кэш лимитов', async () => {
  const { quota, calls } = await fixture();
  await quota.read();
  await quota.reset();
  await quota.read();
  assert.equal(calls(), 2);
});

test('выход во время запроса не восстанавливает старые данные', async () => {
  let finish;
  const { quota } = await fixture({ fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
  const pending = quota.read();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  const logout = quota.logout();
  finish(Response.json(payload));
  await Promise.all([pending, logout]);
  assert.deepEqual(await quota.read(), { status: 'signed-out' });
});

test('401 требует повторного входа, но не стирает сохранённую авторизацию', async () => {
  const { quota, grant } = await fixture({ fetchImpl: async () => Response.json({ error: 'private details' }, { status: 401 }) });
  const result = await quota.read();
  assert.equal(result.error, 'QUOTA_HTTP_401');
  assert(grant());
  assert(!result.data);
});

test('обновление токена выполняется под блокировкой и сохраняет новый grant', async () => {
  let refreshed = 0;
  const { quota, grant } = await fixture({ now: () => Date.now() + 3600000, oauth: { refresh: async () => { refreshed++; return { type: 'oauth', access: 'new-access', refresh: 'new-refresh', accountId: 'test-account', expires: Date.now() + 7200000 }; } }, fetchImpl: async (_, options) => {
    assert.equal(options.headers.Authorization, 'Bearer new-access');
    return Response.json(payload);
  } });
  await quota.read();
  assert.equal(refreshed, 1);
  assert.equal(grant().refresh, 'new-refresh');
});
