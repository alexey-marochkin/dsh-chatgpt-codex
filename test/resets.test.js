import test from 'node:test';
import assert from 'node:assert/strict';
import { createResets, normalizeResets, normalizeResetHistory } from '../resets.js';

const credit = { id: 'credit-1', reset_type: 'codex_rate_limits', status: 'available', title: 'Full reset', expires_at: '2099-01-01T00:00:00Z' };
const list = { available_count: 1, credits: [credit] };
const history = { window_start: '2026-10-17T00:00:00Z', as_of: '2026-11-16T00:00:00Z', next_cursor: null, events: [
  { id: 'received-1', kind: 'granted', occurred_at: '2026-10-31T19:58:54Z' },
  { id: 'used-1', kind: 'used', occurred_at: '2026-11-06T11:54:42Z' },
  { id: 'received-2', kind: 'granted', occurred_at: '2026-11-12T22:27:54Z' }
] };

test('история читается отдельным GET и включает события получения ещё доступных сбросов', async () => {
  const f = fixture(async url => Response.json(url.endsWith('/history') ? history : list));
  assert.equal((await f.resets.list()).credits.every(item => item.status === 'available'), true);
  const result = await f.resets.history();
  assert.deepEqual(result.events.map(item => item.kind), ['granted', 'used', 'granted']);
  assert.equal(result.events[1].occurredAt, Date.parse('2026-11-06T11:54:42Z'));
  assert.equal(f.calls.at(-1).url, 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/history');
  assert(f.calls.every(item => item.method === 'GET'));
});

test('повреждённая или недоступная история не выдаётся за пустую', async () => {
  assert.throws(() => normalizeResetHistory(list), /INVALID_RESET_HISTORY/);
  assert.throws(() => normalizeResetHistory({ ...history, events: [{ id: 'bad', kind: 'used', occurred_at: null }] }), /INVALID_RESET_HISTORY/);
  assert.deepEqual(normalizeResetHistory({ ...history, events: [] }).events, []);
  const f = fixture(async () => Response.json({}, { status: 503 }));
  await assert.rejects(f.resets.history(), /RESET_HTTP_503/);
});

// Создаёт изолированный сервер сбросов; реальные credentials и сеть в тестах не используются.
function fixture(respond = async (_, options) => Response.json(options.method === 'POST' ? { code: 'reset' } : list)) {
  const calls = [], events = [];
  let grant = { access: 'secret-access', refresh: 'secret-refresh', accountId: 'account-1', expires: Date.now() + 3600000 };
  const credentials = { read: async () => grant, modify: async (_, fn) => { grant = await fn(grant) ?? grant; return grant; } };
  const options = { credentials, oauth: {}, journal: { write: (...args) => events.push(args) }, fetchImpl: async (url, init) => {
    calls.push({ url, ...init });
    assert.equal(init.headers.Authorization, 'Bearer secret-access');
    assert.equal(init.headers['ChatGPT-Account-Id'], 'account-1');
    assert.equal(init.redirect, 'error');
    return respond(url, init);
  } };
  return { resets: createResets(options), restart: () => createResets(options), calls, events, clear: () => { grant = undefined; } };
}

test('список и история не расходуют сбросы и не раскрывают персональные поля', async () => {
  const f = fixture(async () => Response.json({ ...list, account_id: 'account-1', credits: [{ ...credit, profile_image_url: 'private-url', profile_user_id: 'private-user' }] }));
  const result = await f.resets.list();
  assert.equal(result.available, 1);
  assert.equal(result.credits[0].expiresAt, Date.parse(credit.expires_at));
  assert(f.calls.every(item => item.method === 'GET'));
  assert.doesNotMatch(JSON.stringify(result), /secret|private/);
  assert.throws(() => normalizeResets({ available_count: -1, credits: [] }), /INVALID_RESETS/);
});

test('без подтверждения и допустимого идентификатора нет даже сетевого запроса', async () => {
  const f = fixture();
  for (const input of [{ creditId: 'credit-1' }, { creditId: '', confirmed: true }, { creditId: 'credit-1', confirmed: 'true' }]) {
    await assert.rejects(f.resets.consume(input), /INVALID_RESET_REQUEST/);
  }
  assert.equal(f.calls.length, 0);
});

test('отправляется только выбранный сброс, с устойчивым UUID даже после перезапуска', async () => {
  const f = fixture();
  assert.deepEqual(await f.resets.consume({ creditId: 'credit-1', confirmed: true }), { code: 'reset' });
  await f.restart().consume({ creditId: 'credit-1', confirmed: true });
  const posts = f.calls.filter(item => item.method === 'POST');
  assert.equal(posts[0].url, 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume');
  const body = JSON.parse(posts[0].body);
  assert.equal(body.credit_id, 'credit-1');
  assert.match(body.redeem_request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(posts[0].body, posts[1].body);
  assert.doesNotMatch(JSON.stringify(f.events), /secret|credit-1|account-1/);
});

test('просроченные, чужие, неизвестные и уже использованные сбросы не отправляются', async () => {
  for (const patch of [{ expires_at: '2000-01-01T00:00:00Z' }, { status: 'expired' }, { reset_type: 'unknown' }, { id: 'other-credit' }, { expires_at: 'invalid' }]) {
    const f = fixture(async () => Response.json({ ...list, credits: [{ ...credit, ...patch }] }));
    await assert.rejects(f.resets.consume({ creditId: 'credit-1', confirmed: true }), /RESET_UNAVAILABLE/);
    assert(f.calls.every(item => item.method === 'GET'));
  }
  const f = fixture(async () => Response.json({ ...list, credits: [{ ...credit, status: 'redeemed' }] }));
  assert.deepEqual(await f.resets.consume({ creditId: 'credit-1', confirmed: true }), { code: 'already_redeemed' });
  assert.equal(f.calls.length, 1);
});

test('параллельные подтверждения одной строки объединяются; другая строка ждёт', async () => {
  let finish;
  const f = fixture(async (_, options) => options.method === 'POST' ? new Promise(resolve => { finish = resolve; }) : Response.json(list));
  const a = f.resets.consume({ creditId: 'credit-1', confirmed: true });
  const b = f.resets.consume({ creditId: 'credit-1', confirmed: true });
  await assert.rejects(f.resets.consume({ creditId: 'credit-2', confirmed: true }), /RESET_BUSY/);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  finish(Response.json({ code: 'reset' }));
  assert.deepEqual(await a, await b);
  assert.equal(f.calls.filter(item => item.method === 'POST').length, 1);
});

test('потерянный ответ не вызывает автоматического повтора, ручной повтор сохраняет ключ', async () => {
  const f = fixture(async (_, options) => { if (options.method === 'POST') throw new Error('private server error'); return Response.json(list); });
  await assert.rejects(f.resets.consume({ creditId: 'credit-1', confirmed: true }), /^Error: RESET_FAILED$/);
  assert.equal(f.calls.filter(item => item.method === 'POST').length, 1);
  await assert.rejects(f.restart().consume({ creditId: 'credit-1', confirmed: true }), /RESET_FAILED/);
  const posts = f.calls.filter(item => item.method === 'POST');
  assert.equal(posts[0].body, posts[1].body);
  assert.doesNotMatch(JSON.stringify(f.events), /private/);
});

test('отмена во время проверки доступности запрещает последующий POST', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.resets.consume({ creditId: 'credit-1', confirmed: true });
  const rejected = assert.rejects(pending, /RESET_FAILED/);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  const cancelled = f.resets.cancel();
  finish(Response.json(list));
  await Promise.all([rejected, cancelled]);
  assert(f.calls.every(item => item.method === 'GET'));
});

test('серверные исходы передаются без придуманного успеха; ошибки и смена аккаунта закрыты', async () => {
  for (const code of ['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed']) {
    const f = fixture(async (_, options) => Response.json(options.method === 'POST' ? { code } : list));
    assert.equal((await f.resets.consume({ creditId: 'credit-1', confirmed: true })).code, code);
  }
  const denied = fixture(async () => Response.json({}, { status: 401 }));
  await assert.rejects(denied.resets.list(), /RESET_HTTP_401/);
  const wrong = fixture(async () => Response.json({ ...list, account_id: 'other' }));
  await assert.rejects(wrong.resets.consume({ creditId: 'credit-1', confirmed: true }), /ACCOUNT_MISMATCH/);
  assert.equal(wrong.calls.length, 1);
  const changed = fixture(async () => { changed.clear(); return Response.json(list); });
  await assert.rejects(changed.resets.consume({ creditId: 'credit-1', confirmed: true }), /AUTH_REQUIRED/);
  assert.equal(changed.calls.length, 1);
});
