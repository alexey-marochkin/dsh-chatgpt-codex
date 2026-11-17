import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentialStore, selectModels, beginLogin } from '../core.js';

// Имитирует атомарное хранилище DSH, сохраняя семантику undefined: оставить прежнюю запись.
function store() {
  const records = new Map();
  return {
    records,
    async readRecord(key) { return records.get(key); },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key));
      if (next !== undefined) records.set(key, next);
      return records.get(key);
    },
    async deleteRecord(key) { records.delete(key); }
  };
}

test('обновление токена сохраняется, undefined не стирает токен и чужие записи', async () => {
  const db = store();
  db.records.set('other', { kind: 'grant', payload: { access: 'other' } });
  const credentials = credentialStore(db, 'account');
  await credentials.modify('openai', () => ({ type: 'oauth', access: 'first' }));
  await credentials.modify('openai', () => undefined);
  assert.equal((await credentials.read('openai')).access, 'first');
  await credentials.modify('openai', current => ({ ...current, access: 'renewed' }));
  assert.equal((await credentials.read('openai')).access, 'renewed');
  await credentials.delete('openai');
  assert.equal(await credentials.read('openai'), undefined);
  assert.equal(db.records.get('other').payload.access, 'other');
});

test('каталог содержит только доступные аккаунту и известные адаптеру модели', () => {
  const known = [{ id: 'sol', name: 'Sol' }, { id: 'spark', name: 'Spark' }];
  assert.deepEqual(selectModels({ models: [{ slug: 'sol', display_name: 'My Sol', visibility: 'list' }, { slug: 'spark', visibility: 'hidden' }, { slug: 'future', visibility: 'list' }] }, known), [{ id: 'sol', name: 'My Sol' }]);
  assert.throws(() => selectModels({ error: 'bad' }, known));
});

test('отмена не записывает результат даже если библиотека завершилась позднее', async () => {
  const db = store();
  const controller = new AbortController();
  await assert.rejects(beginLogin({
    login: async () => { controller.abort(); return { type: 'oauth', access: 'a', refresh: 'r', accountId: 'account', expires: Date.now() + 3600000 }; },
    credentials: credentialStore(db, 'account'), interaction: { signal: controller.signal },
  }));
  assert.equal(db.records.size, 0);
});
