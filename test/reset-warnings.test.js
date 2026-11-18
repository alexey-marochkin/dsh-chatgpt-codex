import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResetWarnings } from '../reset-warnings.js';

// Подменяет сервер и время, сохраняя отметки в отдельном временном профиле.
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'reset-warnings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = 1000000, accountId = 'account', fail = false;
  const credits = [];
  const options = { file: join(dir, 'warnings.json'), now: () => now,
    credentials: { read: async () => accountId ? { accountId } : undefined },
    resets: { list: async () => { if (fail) throw new Error('offline'); return { available: credits.length, credits }; } } };
  return { open: () => createResetWarnings(options), credits,
    advance: ms => { now += ms; }, account: value => { accountId = value; }, fail: value => { fail = value; },
    credit: (id, hours, status = 'available') => ({ id, status, type: 'codex_rate_limits', expiresAt: now + hours * 3600000 }) };
}

test('предупреждает от 48 часов включительно, исключает просроченные, использованные и без даты', async t => {
  const f = await fixture(t);
  f.credits.push(f.credit('boundary', 48), f.credit('soon', 1), f.credit('later', 48.01), f.credit('expired', 0), f.credit('used', 2, 'redeemed'), { ...f.credit('unknown', 1), expiresAt: null });
  assert.deepEqual((await f.open().check()).map(x => x.id).sort(), ['boundary', 'soon']);
});

test('не повторяет после перезапуска, параллельных запросов и повторного входа; разделяет аккаунты', async t => {
  const f = await fixture(t);
  f.credits.push(f.credit('reset', 24));
  const warnings = f.open();
  const results = await Promise.all([warnings.check(), warnings.check()]);
  assert.equal(results.flat().length, 1);
  assert.deepEqual(await f.open().check(), []);
  f.account('other');
  assert.equal((await f.open().check()).length, 1);
  f.account('account');
  assert.deepEqual(await f.open().check(), []);
});

test('ошибка сервера не отмечает сброс, новый сброс вызывает отдельное предупреждение', async t => {
  const f = await fixture(t);
  f.credits.push(f.credit('first', 2));
  f.fail(true);
  await assert.rejects(f.open().check());
  f.fail(false);
  assert.equal((await f.open().check()).length, 1);
  f.credits.push(f.credit('second', 3));
  assert.deepEqual((await f.open().check()).map(x => x.id), ['second']);
  f.account(null);
  assert.deepEqual(await f.open().check(), []);
});
