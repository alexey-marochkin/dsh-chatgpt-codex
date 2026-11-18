import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { catalogRows } from './catalog.js';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const MAX_AGE = 24 * 60 * 60 * 1000;

// Сопоставляет кэш с аккаунтом, не сохраняя исходный идентификатор аккаунта.
function accountKey(accountId) { return createHash('sha256').update(accountId).digest('hex'); }

// Хранит только публичные поля каталога; ошибки диска не блокируют подключение.
export function createCatalogCache(file, now = Date.now) {
  return {
    // Принимает только свежий каталог текущего аккаунта с известной версией формата.
    async read(accountId) {
      if (!file || !accountId) return null;
      try {
        const data = JSON.parse(await readFile(file, 'utf8'));
        if (data.version !== 1 || data.account !== accountKey(accountId) || !Number.isFinite(data.fetchedAt)
          || now() < data.fetchedAt || now() - data.fetchedAt >= MAX_AGE || !Array.isArray(data.models)
          || !data.models.every(model => model && typeof model.slug === 'string' && model.visibility === 'list'
            && (model.display_name === undefined || typeof model.display_name === 'string'))) return null;
        return { models: data.models, expiresAt: data.fetchedAt + MAX_AGE };
      } catch { return null; }
    },
    // Атомарно заменяет файл, исключая токены и неиспользуемые поля ответа сервера.
    async save(accountId, catalog) {
      if (!file || !accountId) return;
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const models = catalog.models.filter(model => model?.visibility === 'list' && typeof model.slug === 'string')
          .map(model => ({ slug: model.slug, visibility: 'list', ...(Array.isArray(model.supported_reasoning_levels) ? { supported_reasoning_levels: model.supported_reasoning_levels.filter(item => ['minimal','low','medium','high','xhigh','max'].includes(item?.effort)).map(item => ({ effort: item.effort })) } : {}), ...(model.service_tiers || model.additional_speed_tiers ? { service_tiers: catalogRows({ models: [model] }, [])[0].tiers.map(id => ({ id })) } : {}), ...(typeof model.display_name === 'string' ? { display_name: model.display_name } : {}) }));
        await mkdir(dirname(file), { recursive: true });
        await writeFile(temporary, JSON.stringify({ version: 1, account: accountKey(accountId), fetchedAt: now(), models }), { mode: 0o600 });
        await rename(temporary, file);
      } catch { /* Кэш необязателен: ответ сервера остаётся доступен в памяти. */ }
      finally { await rm(temporary, { force: true }).catch(() => {}); }
    },
    // Удаляет каталог при выходе или смене авторизации.
    async clear() { if (file) await rm(file, { force: true }).catch(() => {}); }
  };
}
