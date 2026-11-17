import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJournal, settingsDiagnostic } from '../journal.js';

test('журнал пишет события в порядке возникновения и сохраняет предыдущий файл при ротации', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-journal-test-'));
  const file = join(directory, 'dsh.log');
  try {
    await writeFile(file, 'x'.repeat(2 * 1024 * 1024 + 1));
    const emitted = [];
    const journal = createJournal({ info: text => emitted.push(text), error: text => assert.fail(text) }, file);
    journal.write('info', 'login.succeeded', { operationId: 'test' });
    journal.write('info', 'settings.save.succeeded', { operationId: 'test' });
    await journal.flush();
    const records = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map(row => row.event), ['login.succeeded', 'settings.save.succeeded']);
    assert.equal(emitted.length, 2);
    assert.equal((await readFile(`${file}.1`)).length, 2 * 1024 * 1024 + 1);
  } finally { await rm(directory, { recursive: true }); }
});

test('диагностика настроек скрывает ключи, токены и URL', () => {
  const diagnostic = settingsDiagnostic(new Error('Bearer secret-value token=abc code=callback https://example.test/?secret=value'));
  assert.doesNotMatch(diagnostic, /secret-value|abc|callback|example\.test/);
});
