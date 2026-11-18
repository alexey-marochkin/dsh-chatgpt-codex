import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Выдаёт предупреждение один раз на аккаунт и сброс; отметки переживают выход и перезапуск DSH.
export function createResetWarnings({ file, credentials, resets, now = Date.now }) {
  let queue = Promise.resolve();
  let lastAccount, lastChecked = -Infinity;

  // Проверяет свежий серверный список и сохраняет отметки до выдачи предупреждений клиенту.
  async function checkOnce() {
    const account = (await credentials.read())?.accountId;
    if (!file || !account || (account === lastAccount && now() - lastChecked < 60000)) return [];
    const details = await resets.list();
    if ((await credentials.read())?.accountId !== account) return [];
    const time = now();
    const credits = details.available > 0 ? details.credits.filter(item => item.status === 'available'
      && Number.isFinite(item.expiresAt) && item.expiresAt > time && item.expiresAt - time <= 48 * 3600000) : [];
    let seen;
    try { seen = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; seen = []; }
    if (!Array.isArray(seen) || !seen.every(key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key))) throw new Error('INVALID_WARNING_STATE');
    const keys = new Set(seen);
    const warnings = [];
    for (const credit of credits) {
      const key = createHash('sha256').update(JSON.stringify([account, credit.id])).digest('hex');
      if (keys.has(key)) continue;
      keys.add(key);
      warnings.push({ id: credit.id, expiresAt: credit.expiresAt });
    }
    if (warnings.length) {
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(temporary, JSON.stringify([...keys]), { mode: 0o600 });
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    }
    lastAccount = account;
    lastChecked = time;
    return (await credentials.read())?.accountId === account ? warnings : [];
  }

  return {
    // Последовательная обработка не даёт двум открытым чатам получить один и тот же сброс.
    check() {
      const result = queue.then(checkOnce);
      queue = result.catch(() => {});
      return result;
    }
  };
}
