// Преобразует ответ OpenAI в разрешённые UI-поля; неизвестные и отсутствующие величины не заменяются нулём.
export function normalizeQuota(body) {
  if (!body || typeof body !== 'object' || !['plan_type', 'rate_limit', 'additional_rate_limits', 'credits'].some(key => key in body)) throw new Error('INVALID_QUOTA');
  const windows = [];
  const groups = [{ metered_feature: 'codex', limit_name: 'Codex', rate_limit: body.rate_limit }, { metered_feature: 'code-review', limit_name: 'Code review', rate_limit: body.code_review_rate_limit }, ...(Array.isArray(body.additional_rate_limits) ? body.additional_rate_limits : [])];
  for (const group of groups) {
    for (const key of ['primary_window', 'secondary_window']) {
      const value = group?.rate_limit?.[key];
      if (!value || !Number.isFinite(value.used_percent) || !Number.isFinite(value.limit_window_seconds) || value.limit_window_seconds <= 0) continue;
      windows.push({ id: `${String(group.metered_feature).slice(0,100)}:${key}`, name: String(group.limit_name ?? group.metered_feature ?? 'Codex').slice(0,100),
        seconds: value.limit_window_seconds, remainingPercent: Math.max(0, Math.min(100, 100 - value.used_percent)),
        resetsAt: Number.isFinite(value.reset_at) && value.reset_at > 0 && value.reset_at < 8640000000000 ? value.reset_at : null });
    }
  }
  const individual = body.spend_control?.individual_limit;
  return { plan: typeof body.plan_type === 'string' ? body.plan_type.slice(0,80) : null, windows,
    weekly: windows.find(item => item.id.startsWith('codex:') && item.seconds === 604800) ?? null,
    credits: body.credits ? { unlimited: body.credits.unlimited === true, balance: typeof body.credits.balance === 'string' && /^\d+(\.\d+)?$/.test(body.credits.balance) ? body.credits.balance.slice(0,40) : null } : null,
    individual: individual && Number.isFinite(individual.remaining_percent) ? { remainingPercent: Math.max(0,Math.min(100,individual.remaining_percent)), resetsAt: Number.isFinite(individual.reset_at) ? individual.reset_at : null } : null,
    allowed: typeof body.rate_limit?.allowed === 'boolean' ? body.rate_limit.allowed : null,
    spendControlReached: body.spend_control?.reached === true,
    resetsAvailable: Number.isSafeInteger(body.rate_limit_reset_credits?.available_count) && body.rate_limit_reset_credits.available_count >= 0 ? body.rate_limit_reset_credits.available_count : null };
}

// Читает лимиты с общим входом коннектора, обновляя токен под блокировкой хранилища DSH.
export async function createQuota({ credentials, oauth, journal, fetchImpl = fetch, now = Date.now }) {
  let state = { status: await credentials.read() ? 'stored' : 'signed-out' };
  let loading, requestController;
  let suspended = false;
  let lastAttempt = 0;
  let disposed = false;

  // Возвращает только стабильный диагностический код, не текст ответа или OAuth-ошибки.
  function errorCode(error) {
    if (/^QUOTA_HTTP_\d{3}$/.test(error?.message) || error?.message === 'INVALID_QUOTA' || error?.message === 'ACCOUNT_MISMATCH') return error.message;
    return 'QUOTA_FAILED';
  }

  // Отменяет текущий сетевой запрос и дожидается завершения, чтобы поздний ответ не восстановил кэш.
  async function stopRequest() { requestController?.abort(); await loading; }

  // Читает реальные лимиты; ручное обновление обходит кэш, но параллельные запросы объединяются.
  async function read(force = false) {
    if (disposed || suspended) return state;
    if (loading) return loading;
    if (!force && now() - lastAttempt < 60000) return state;
    const controller = new AbortController();
    requestController = controller;
    loading = (async () => {
      try {
        let grant = await credentials.read();
        if (!grant) return state = { status: 'signed-out' };
        lastAttempt = now();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
        grant = await credentials.modify('openai-codex', async current => {
          if (!current) throw new Error('AUTH_REQUIRED');
          if (current.expires > now() + 60000) return undefined;
          const next = await oauth.refresh(current, signal);
          signal.throwIfAborted();
          return next;
        });
        signal.throwIfAborted();
        const response = await fetchImpl('https://chatgpt.com/backend-api/wham/usage', {
          headers: { Authorization: `Bearer ${grant.access}`, 'ChatGPT-Account-Id': grant.accountId, Accept: 'application/json' },
          signal, redirect: 'error'
        });
        if (!response.ok) throw new Error(`QUOTA_HTTP_${response.status}`);
        const body = await response.json();
        signal.throwIfAborted();
        if (body.account_id && body.account_id !== grant.accountId) throw new Error('ACCOUNT_MISMATCH');
        state = { status: 'connected', data: normalizeQuota(body), fetchedAt: now(), account: grant.accountId.slice(-8) };
        journal.write('info', 'quota.refresh.succeeded', { windows: state.data.windows.length });
      } catch (error) {
        if (!controller.signal.aborted) {
          state = { ...state, status: 'error', error: errorCode(error) };
          journal.write('warn', 'quota.refresh.failed', { code: state.error });
        }
      }
      return state;
    })();
    try { return await loading; } finally { loading = undefined; requestController = undefined; }
  }

  // Сбрасывает кэш после общего входа, не позволяя старому ответу восстановить данные аккаунта.
  async function reset() {
    suspended = true;
    try { await stopRequest(); lastAttempt = 0; state = { status: await credentials.read() ? 'stored' : 'signed-out' }; }
    finally { suspended = false; }
  }

  // Выход очищает общий вход моделей и лимитов после завершения запроса статистики.
  async function logout() {
    suspended = true;
    try { await stopRequest(); await credentials.delete(); lastAttempt = 0; state = { status: 'signed-out' }; return state; }
    finally { suspended = false; }
  }

  return { read, reset, logout,
    // Завершает чтение без очистки сохранённой авторизации.
    async dispose() { disposed = true; await stopRequest(); }
  };
}
