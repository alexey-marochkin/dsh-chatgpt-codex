// Адаптирует отдельную запись DSH к хранилищу pi-ai; обновление проходит под блокировкой DSH.
export function credentialStore(db, key) {
  return {
    async read() { return (await db.readRecord(key))?.payload; },
    async list() { return await db.readRecord(key) ? [{ providerId: 'openai-codex', type: 'oauth' }] : []; },
    async modify(_provider, mutate) {
      const record = await db.modifyRecord(key, async current => {
        const next = await mutate(current?.payload);
        return next === undefined ? undefined : { kind: 'grant', payload: JSON.parse(JSON.stringify(next)) };
      });
      return record?.payload;
    },
    async delete() { await db.deleteRecord(key); }
  };
}

// Пересекает серверный каталог аккаунта с моделями, метаданные которых знает установленный адаптер.
export function selectModels(catalog, known) {
  if (!Array.isArray(catalog?.models)) throw new Error('INVALID_MODEL_CATALOG');
  const result = [];
  for (const entry of catalog.models) {
    if (entry?.visibility !== 'list' || typeof entry.slug !== 'string') continue;
    const model = known.find(model => model.id === entry.slug);
    if (model && !result.some(item => item.id === model.id)) result.push({ ...model, name: typeof entry.display_name === 'string' ? entry.display_name : model.name });
  }
  return result;
}

// Выполняет библиотечный OAuth и запрещает позднюю запись после отмены пользователем.
export async function beginLogin({ login, credentials, interaction }) {
  const grant = await login(interaction, { agentName: 'ChatGPT - Codex (DSH)' });
  interaction.signal.throwIfAborted();
  if (grant?.type !== 'oauth' || !grant.access || !grant.refresh || typeof grant.accountId !== 'string' || !grant.accountId || !Number.isFinite(grant.expires)) throw new Error('INVALID_OAUTH_RESULT');
  await credentials.modify('openai-codex', () => {
    interaction.signal.throwIfAborted();
    return grant;
  });
}
