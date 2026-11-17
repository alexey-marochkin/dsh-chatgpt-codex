import { createHash } from 'node:crypto';

// Читает именно события журнала OpenAI, а не статусы записей из списка доступных сбросов.
export function normalizeResetHistory(body) {
  if (!Array.isArray(body?.events) || !Number.isFinite(Date.parse(body.window_start)) || !Number.isFinite(Date.parse(body.as_of))) throw new Error('INVALID_RESET_HISTORY');
  return { events: body.events.map(item => {
    if (typeof item?.id !== 'string' || typeof item.kind !== 'string' || !Number.isFinite(Date.parse(item.occurred_at))) throw new Error('INVALID_RESET_HISTORY');
    return { id: item.id.slice(0, 200), kind: item.kind.slice(0, 40), occurredAt: Date.parse(item.occurred_at) };
  }).sort((a, b) => b.occurredAt - a.occurredAt), windowStart: Date.parse(body.window_start), asOf: Date.parse(body.as_of) };
}

// Оставляет только поля списка сбросов, необходимые интерфейсу; персональные данные не передаются.
export function normalizeResets(body) {
  if (!Array.isArray(body?.credits) || !Number.isSafeInteger(body.available_count) || body.available_count < 0) throw new Error('INVALID_RESETS');
  return { available: body.available_count, credits: body.credits.filter(item => typeof item?.id === 'string' && item.id.length > 0 && item.id.length <= 200).map(item => ({
    id: item.id, type: String(item.reset_type ?? '').slice(0, 80), status: String(item.status ?? '').slice(0, 40),
    title: typeof item.title === 'string' ? item.title.slice(0, 160) : null,
    expiresAt: item.expires_at == null ? null : Number.isFinite(Date.parse(item.expires_at)) ? Date.parse(item.expires_at) : 0
  })) };
}

// UUID v5 стабилен для аккаунта и конкретного сброса, включая повтор после перезапуска DSH.
function redemptionId(accountId, creditId) {
  const bytes = createHash('sha1').update(Buffer.alloc(16)).update(`dsh-chatgpt-codex/reset/${accountId}/${creditId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Загружает список и использует только явно выбранный и подтверждённый сброс с общим входом коннектора.
export function createResets({ credentials, oauth, journal, fetchImpl = fetch, now = Date.now }) {
  const requests = new Map();
  let consuming;
  let suspended = false;

  // Выполняет запрос с обновлением общей авторизации и возвращает только безопасные ошибки.
  async function run(task) {
    if (suspended) throw new Error('RESET_BUSY');
    const controller = new AbortController();
    const operation = (async () => {
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
        const grant = await credentials.modify('openai-codex', async current => {
          if (!current) throw new Error('AUTH_REQUIRED');
          if (current.expires > now() + 60000) return undefined;
          const next = await oauth.refresh(current, signal);
          signal.throwIfAborted();
          return next;
        });
        // Все пути фиксированы в модуле; идентификатор сброса передаётся только в JSON.
        const request = async (action, body) => {
          const consume = action === 'consume';
          signal.throwIfAborted();
          const response = await fetchImpl(`https://chatgpt.com/backend-api/wham/rate-limit-reset-credits${consume ? '/consume' : action === 'history' ? '/history' : ''}`, {
            method: consume ? 'POST' : 'GET', signal, redirect: 'error',
            headers: { Authorization: `Bearer ${grant.access}`, 'ChatGPT-Account-Id': grant.accountId, Accept: 'application/json', ...(consume ? { 'Content-Type': 'application/json' } : {}) },
            ...(consume ? { body: JSON.stringify(body) } : {})
          });
          if (!response.ok) throw new Error(`RESET_HTTP_${response.status}`);
          const result = await response.json();
          signal.throwIfAborted();
          if (result.account_id && result.account_id !== grant.accountId) throw new Error('ACCOUNT_MISMATCH');
          return result;
        };
        return await task(request, grant, signal);
      } catch (error) {
        const code = /^(RESET_HTTP_\d{3}|AUTH_REQUIRED|INVALID_RESETS|INVALID_RESET_HISTORY|RESET_UNAVAILABLE|ACCOUNT_MISMATCH)$/.test(error?.message) ? error.message : 'RESET_FAILED';
        journal.write('warn', 'quota.resets.failed', { code });
        throw new Error(code);
      }
    })();
    requests.set(controller, operation);
    try { return await operation; } finally { requests.delete(controller); }
  }

  // Читает доступные сбросы без расходования сбросов.
  async function list() { return run(async request => normalizeResets(await request('list'))); }

  // Загружает отдельный серверный журнал получения и использования сбросов.
  async function history() { return run(async request => normalizeResetHistory(await request('history'))); }

  // Не повторяет POST автоматически; одинаковый сброс всегда получает одинаковый ключ идемпотентности.
  async function consume({ creditId, confirmed } = {}) {
    if (confirmed !== true || typeof creditId !== 'string' || !creditId.length || creditId.length > 200) throw new Error('INVALID_RESET_REQUEST');
    if (consuming) {
      if (consuming.creditId !== creditId) throw new Error('RESET_BUSY');
      return consuming.promise;
    }
    const promise = run(async (request, grant, signal) => {
      const details = normalizeResets(await request('list'));
      const credit = details.credits.find(item => item.id === creditId);
      if (credit?.status === 'redeemed') return { code: 'already_redeemed' };
      if (!credit || credit.status !== 'available' || credit.type !== 'codex_rate_limits' || (credit.expiresAt !== null && credit.expiresAt <= now()) || details.available < 1) throw new Error('RESET_UNAVAILABLE');
      if ((await credentials.read())?.accountId !== grant.accountId) throw new Error('AUTH_REQUIRED');
      signal.throwIfAborted();
      journal.write('info', 'quota.reset.started');
      const result = await request('consume', { credit_id: creditId, redeem_request_id: redemptionId(grant.accountId, creditId) });
      if (!['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed'].includes(result.code)) throw new Error('INVALID_RESETS');
      journal.write('info', 'quota.reset.completed', { code: result.code });
      return { code: result.code };
    });
    consuming = { creditId, promise };
    try { return await promise; } finally { consuming = undefined; }
  }

  // Останавливает запросы перед сменой аккаунта, выходом или выгрузкой плагина.
  async function cancel() {
    suspended = true;
    try {
      for (const controller of requests.keys()) controller.abort();
      await Promise.allSettled([...requests.values()]);
    } finally { suspended = false; }
  }
  return { list, history, consume, cancel };
}
