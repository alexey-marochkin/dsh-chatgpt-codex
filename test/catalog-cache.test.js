import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCatalogCache } from '../catalog-cache.js';

// Создаёт отдельное хранилище и управляемое время без обращения к аккаунтам пользователя.
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-catalog-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'catalog.json');
  let now = 100000000;
  const open = () => createCatalogCache(file, () => now);
  return { file, open, advance: value => { now += value; } };
}

test('каталог переживает перезапуск, не сохраняет секреты и изолирован по аккаунту', async t => {
  const f = await fixture(t);
  await f.open().save('private-account', { models: [{ slug: 'model', visibility: 'list', display_name: 'Model', token: 'secret' }, { slug: 'hidden', visibility: 'hidden' }] });
  const restored = await f.open().read('private-account');
  assert.deepEqual(restored.models, [{ slug: 'model', visibility: 'list', display_name: 'Model' }]);
  assert.equal(await f.open().read('another-account'), null);
  assert.equal(await f.open().read(undefined), null);
  assert.doesNotMatch(await readFile(f.file, 'utf8'), /private-account|secret|hidden/);
});

test('каталог истекает через 24 часа; дата из будущего не принимается', async t => {
  const f = await fixture(t);
  await f.open().save('account', { models: [] });
  f.advance(86400000 - 1);
  assert.ok(await f.open().read('account'));
  f.advance(1);
  assert.equal(await f.open().read('account'), null);
  f.advance(-86400001);
  assert.equal(await f.open().read('account'), null);
});

test('повреждённый кэш игнорируется, очистка удаляет каталог', async t => {
  const f = await fixture(t);
  await writeFile(f.file, '{broken');
  assert.equal(await f.open().read('account'), null);
  await f.open().save('account', { models: [] });
  await f.open().clear();
  assert.equal(await f.open().read('account'), null);
});


test('кэш сохраняет только разрешённые скорости и восстанавливает их после перезапуска', async t => {
  const f = await fixture(t);
  await f.open().save('account', {models:[{slug:'model',visibility:'list',service_tiers:[{id:'priority',secret:'private'},{id:'ultrafast'},{id:'arbitrary'}]}]});
  assert.deepEqual((await f.open().read('account')).models[0].service_tiers, [{id:'default'},{id:'priority'},{id:'ultrafast'}]);
  assert.doesNotMatch(await readFile(f.file, 'utf8'), /private|arbitrary/);
});
