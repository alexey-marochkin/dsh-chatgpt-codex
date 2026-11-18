import { LlmAdapter, createUserMessage, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { generateImage } from './images.js';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { credentialKey } from '@deepseek-ai/dsh-credentials';
import { createModels } from '@earendil-works/pi-ai/models';
import { credentialStore, selectModels, beginLogin } from './core.js';
import z from '@deepseek-ai/schemastery';
import { randomUUID } from 'node:crypto';
import { createJournal, settingsDiagnostic } from './journal.js';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { createQuota } from './quota.js';
import { createResets } from './resets.js';
import { createCatalogCache } from './catalog-cache.js';
import { createResetWarnings } from './reset-warnings.js';
import { withExperimentalModels, catalogRows, speedProvider } from './catalog.js';

export const name = 'chatgpt-codex';
export const inject = ['llm', 'credentials', 'connection', 'settings'];
export const Config = z.object({ providers: z.dict(z.object({ speeds: z.dict(z.string()).default({}), reasoningDefaults: z.dict(z.string()).default({}) })).default({}).volatile() });
const ROUTE = 'chatgpt-codex';
const TITLE = 'ChatGPT - Codex';

// Подключает отдельный провайдер и защищённые операции входа к существующим сервисам DSH.
export async function apply(ctx, config) {
  const journal = createJournal(ctx.logger, ctx.get('dshHomePath')?.('logs', 'dsh.log'));
  ctx.on('dispose', () => journal.flush());
  const settingsNs = ctx.fiber?.entry?.options.id ?? ROUTE;
  const configured = () => config.providers.get()[ROUTE] !== undefined;
  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber));
  ctx.llm.registerConfigurableProviders([{ provider: ROUTE, displayName: TITLE, settingsNs, settingsPath: ['providers', ROUTE], nativeAuth: { env: [], oauth: true } }]);
  ctx.on('loader/volatile-update', () => ctx.emit('llm/models-updated', ROUTE));
  // Сохраняем прежний ключ лимитов: этот вход теперь общий для моделей и статистики.
  const credentials = credentialStore(ctx.credentials, credentialKey(ROUTE, 'limits'));
  const provider = openaiCodexProvider();
  const quota = await createQuota({ credentials, oauth: provider.auth.oauth, journal });
  const resets = createResets({ credentials, oauth: provider.auth.oauth, journal });
  const resetWarnings = createResetWarnings({ credentials, resets, file: ctx.get('dshHomePath')?.('storages', 'chatgpt-codex', 'reset-warnings.json') });
  ctx.on('dispose', () => resets.cancel());
  ctx.on('dispose', () => quota.dispose());
  const known = withExperimentalModels(provider.getModels());
  const models = createModels({ credentials });
  models.setProvider(provider);
  // Получает токен через pi-ai и сверяет аккаунт после возможного обновления авторизации.
  async function getImageGrant(signal) {
    if (!configured()) return;
    const auth = await models.getAuth('openai-codex', { signal });
    const grant = await credentials.read();
    if (grant?.access && grant.access === auth?.auth?.apiKey) return grant;
  }
  ctx.inject(['tools', 'attachments'], scope => {
    // Отображает изображение в обычном вызове и передаёт его в диалог при вложенном вызове.
    const content = ({ attachment, sourcePath, filename }) => [
      { type: 'text', text: JSON.stringify({ sourcePath, filename }) },
      { type: 'image', attachment }
    ];
    scope.tools.register(defineTool({
      name: 'chatgpt_codex_generate_image',
      description: 'Generate a new image using the connected ChatGPT subscription. Choose a short descriptive filename in the user’s language, using their requested name when given. When sourcePath is available, copy the image from there into the session working directory using filename and the standard workspace tools. Keep the source intact and avoid overwriting existing files. Call present on the saved file for the native file card. Include ![description](<saved path>) and a descriptive Markdown link to that same file in your final answer. Never link to the internal sourcePath.',
      parameters: {
        prompt: { type: 'string', required: true, description: 'Description of the requested new image.' },
        filename: { type: 'string', required: true, description: 'Suggested filename without a directory or extension, for example Маяк в тумане. The plugin supplies the extension.' },
        quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'] },
        background: { type: 'string', enum: ['auto', 'opaque', 'transparent'] }
      },
      output: { schema: { type: 'object', properties: {
        attachment: { type: 'object', properties: { attachmentId: { type: 'string', required: true } }, additionalProperties: true, required: true },
        sourcePath: { type: 'string' }, filename: { type: 'string', required: true }
      }, additionalProperties: false },
        render: (_args, result) => content(result) },
      timeoutMs: 300000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const attachment = await generateImage(args, exec, { getGrant: getImageGrant, attachments: scope.attachments });
        const hostPath = scope.attachments.imageHostPath?.(attachment);
        const sourcePath = hostPath && scope.get('fs')?.processPathFromHostPath(hostPath);
        const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[attachment.mediaType];
        const filename = (attachment.name || 'codex-image.png').replace(/\.png$/i, '') + '.' + extension;
        const result = { attachment, filename, ...(sourcePath ? { sourcePath } : {}) };
        if (exec.parent !== undefined) exec.deferContext(createUserMessage({ content: content(result), source: { kind: 'chatgpt-codex-image' } }));
        return result;
      }
    }), { when: async () => configured() && Boolean((await credentials.read())?.access) });
  });
  const catalogCache = createCatalogCache(ctx.get('dshHomePath')?.('cache', 'chatgpt-codex', 'catalog.json'));
  const savedGrant = await credentials.read();
  const cachedCatalog = await catalogCache.read(savedGrant?.accountId);
  let diagnostics = { source: cachedCatalog ? 'cache' : 'none', fetchedAt: cachedCatalog ? cachedCatalog.expiresAt - 86400000 : null, rows: catalogRows(cachedCatalog, known), error: null };
  let available = cachedCatalog ? selectModels(cachedCatalog, known) : [];
  let cacheExpiresAt = cachedCatalog?.expiresAt;
  let initialRefresh = false;
  let catalogRevision = 0;
  let profiles;
  let attempt;
  let loading;
  let state = { status: savedGrant ? 'stored' : 'signed-out', modelCount: available.length };
  journal.write('info', 'connector.started', { configured: configured(), hasCredential: state.status === 'stored' });

  // Собирает профиль для экспортируемого адаптера версии 0.2.2-rc.3.
  function updateProfiles() {
    profiles = new Map([['openai-codex', {
      provider: 'openai-codex', displayName: TITLE, piProvider: { ...speedProvider(provider, id => {
        const selected = config.providers.get()[ROUTE]?.speeds?.[id] ?? 'default';
        return diagnostics.rows.find(row => row.id === id)?.tiers.includes(selected) ? selected : 'default';
      }), getModels: () => available, getAllModels: () => available },
      modelErrors: new Map(), configuredMaxTokens: new Map(), streamIdleTimeoutMs: 300000,
      maxRequestImageBytes: 20971520, maxRequestImages: 50, imageOffloadCountQuantum: 10,
      requestImagePixelBudget: 4194304, requestImageMaxBytes: 1048576
    }]]);
    ctx.emit('llm/models-updated', ROUTE);
  }
  updateProfiles();
  const inner = new PiAiAdapter({
    profiles: () => profiles, auth: { credentials }, resolveApiKey: async () => undefined,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, path => ctx.get('fs')?.processPathFromHostPath(path), ref)
  });

  // Обновляет список моделей только по ответу OpenAI с текущей подписочной авторизацией.
  async function refreshCatalog() {
    if (loading) return loading;
    const operationId = randomUUID();
    const started = Date.now();
    const revision = catalogRevision;
    journal.write('info', 'catalog.started', { operationId });
    // Передаём версию встроенного клиента pi-ai; каталог пересекаем с поддерживаемыми им моделями.
    loading = (async () => {
      const grant = await credentials.read();
      if (!grant) return;
      const auth = await models.getAuth('openai-codex', { signal: AbortSignal.timeout(25000) });
      if (!auth?.auth?.apiKey) throw new Error('AUTH_REQUIRED');
      const response = await fetch('https://chatgpt.com/backend-api/codex/models?client_version=1.3.0', {
        headers: { Authorization: `Bearer ${auth.auth.apiKey}`, 'ChatGPT-Account-Id': grant.accountId }, redirect: 'error', signal: AbortSignal.timeout(25000)
      });
      if (!response.ok) throw new Error(`CATALOG_HTTP_${response.status}`);
      const catalog = await response.json();
      const selected = selectModels(catalog, known);
      if (revision !== catalogRevision || (await credentials.read())?.accountId !== grant.accountId) return;
      available = selected;
      diagnostics = { source: 'network', fetchedAt: Date.now(), rows: catalogRows(catalog, known), error: null };
      cacheExpiresAt = undefined;
      state = { status: 'connected', modelCount: available.length };
      updateProfiles();
      await catalogCache.save(grant.accountId, catalog);
      journal.write('info', 'catalog.succeeded', { operationId, modelCount: available.length, durationMs: Date.now() - started });
    })();
    try { await loading; }
    catch (error) {
      if (revision === catalogRevision) diagnostics = { ...diagnostics, error: /^CATALOG_HTTP_\d{3}$/.test(error?.message) ? error.message : 'CATALOG_FAILED' };
      journal.write('warn', 'catalog.failed', { operationId, code: failure(error), durationMs: Date.now() - started }); throw error; }
    finally { loading = undefined; }
  }

  // Не допускает использования восстановленного каталога после истечения срока хранения.
  function expireCachedCatalog() {
    if (cacheExpiresAt && Date.now() >= cacheExpiresAt) {
      available = [];
      diagnostics = { ...diagnostics, source: 'expired', rows: [] };
      cacheExpiresAt = undefined;
      updateProfiles();
    }
  }

  // Применяет настройку модели только когда в чате не выбран явный уровень рассуждения.
  function reasoningDefault(id) {
    const level = config.providers.get()[ROUTE]?.reasoningDefaults?.[id];
    return diagnostics.rows.find(row => row.id === id)?.efforts.includes(level) ? level : undefined;
  }

  // Сообщает селектору DSH тот же уровень по умолчанию, который применяется к запросам.
  function modelInfo(model) {
    const defaultEffort = reasoningDefault(model.id);
    const info = { ...model, provider: ROUTE };
    if (defaultEffort && model.reasoning?.efforts?.some(effort => effort.id === defaultEffort)) {
      info.reasoning = { ...model.reasoning, defaultEffort };
    }
    return info;
  }

  // Переводит имя коннектора DSH в openai-codex только на границе готового адаптера.
  class Connector extends LlmAdapter {
    // Возвращает понятное имя в селекторе провайдеров.
    providerInfo() { return { id: ROUTE, name: TITLE }; }
    // Показывает только подтверждённый каталог подписки.
    async listModels() {
      if (!configured()) return [];
      expireCachedCatalog();
      if (state.status === 'stored' && !initialRefresh) {
        initialRefresh = true;
        const refresh = refreshCatalog().catch(() => {
          state = { status: 'stored', error: 'CATALOG_FAILED', modelCount: available.length };
        });
        if (!cachedCatalog || !available.length) await refresh;
      }
      return (await inner.listModels('openai-codex')).map(model => ({ ...model, provider: ROUTE }));
    }
    // Сохраняет метаданные модели от исходного адаптера.
    async resolveModel(_route, model, signal) { expireCachedCatalog(); return modelInfo(await inner.resolveModel('openai-codex', model, signal)); }
    // Удерживает единый снимок каталога между подготовкой и отправкой запроса.
    async prepareCall(_route, model, signal) {
      expireCachedCatalog();
      const prepared = await inner.prepareCall('openai-codex', model, signal);
      return { model: modelInfo(prepared.model), stream: options => prepared.stream({ ...options, reasoningEffort: options.reasoningEffort ?? reasoningDefault(model), provider: 'openai-codex' }) };
    }
    // Передаёт запрос штатному механизму Responses, включая инструменты и поток ответа.
    stream(options) { expireCachedCatalog(); return inner.stream({ ...options, reasoningEffort: options.reasoningEffort ?? reasoningDefault(options.model), provider: 'openai-codex' }); }
    // Использует штатные ограничения обработки изображений.
    imageRequestTarget(_route, model, image) { return inner.imageRequestTarget('openai-codex', model, image); }
  }
  ctx.llm.registerAdapter([ROUTE], new Connector());

  // Возвращает безопасный код ошибки, исключая ответы сервера, URL callback и токены.
  function failure(error) {
    const code = error?.code ?? error?.cause?.code;
    if (code === 'EADDRINUSE' || error?.message?.includes('Port ')) return 'PORT_BUSY';
    if (error?.message === 'INVALID_SPEED') return 'INVALID_SPEED';
    if (/^CATALOG_HTTP_\d{3}$/.test(error?.message)) return error.message;
    return 'LOGIN_FAILED';
  }

  // Запускает одну попытку входа; вопросы и уведомления возвращаются только владельцу DSH.
  function startLogin() {
    if (attempt) throw new Error('LOGIN_BUSY');
    catalogRevision++;
    const controller = new AbortController();
    const operationId = randomUUID();
    journal.write('info', 'login.started', { operationId });
    const current = { controller, answer: undefined };
    attempt = current;
    state = { status: 'signing-in', modelCount: available.length };
    const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
    current.done = (async () => {
      try {
        await beginLogin({ login: provider.auth.oauth.login, credentials, interaction: {
          signal: controller.signal,
          notify(event) {
            if (event.type === 'auth_url') {
              if (new URL(event.url).origin !== 'https://auth.openai.com') throw new Error('INVALID_AUTH_URL');
              state = { ...state, url: event.url };
            }
          },
          prompt(question) {
            if (question.type === 'select') return Promise.resolve('browser');
            if (question.type !== 'manual_code') throw new Error('UNEXPECTED_PROMPT');
            return new Promise((resolve, reject) => {
              const signal = AbortSignal.any([controller.signal, ...(question.signal ? [question.signal] : [])]);
              const abort = () => { current.answer = undefined; reject(new Error('CANCELLED')); };
              signal.addEventListener('abort', abort, { once: true });
              current.answer = value => { signal.removeEventListener('abort', abort); current.answer = undefined; resolve(value); };
              if (signal.aborted) abort();
            });
          }
        } });
        await quota.reset();
        await resets.cancel();
        journal.write('info', 'login.succeeded', { operationId });
        await loading?.catch(() => {});
        await catalogCache.clear();
        cacheExpiresAt = undefined;
        available = [];
        diagnostics = { source: 'none', fetchedAt: null, rows: [], error: null };
        updateProfiles();
        state = { status: 'stored', modelCount: 0 };
        try { await refreshCatalog(); }
        catch { state = { status: 'stored', error: 'CATALOG_FAILED', modelCount: 0 }; }
      } catch (error) {
        journal.write('warn', controller.signal.aborted ? 'login.cancelled' : 'login.failed', { operationId, code: failure(error) });
        state = { status: controller.signal.aborted ? (await credentials.read() ? 'stored' : 'signed-out') : 'error', error: controller.signal.aborted ? undefined : failure(error), modelCount: available.length };
      } finally {
        clearTimeout(timeout);
        attempt = undefined;
      }
    })();
  }

  // Отменяет попытку и дожидается прекращения записи перед выходом или выгрузкой плагина.
  async function cancel() { const current = attempt; current?.controller.abort(); await current?.done; }
  ctx.on('dispose', cancel);

  // Обрабатывает только фиксированные операции через проверку владельца в Connection.
  async function handle(action, request) {
    try {
      if (action === 'quota-reset-warnings') {
        try {
          if (attempt) throw new Error('RESET_BUSY');
          return Response.json({ warnings: await resetWarnings.check() }, { headers: { 'Cache-Control': 'no-store' } });
        } catch {
          journal.write('warn', 'quota.reset-warnings.failed');
          return Response.json({ error: 'RESET_WARNINGS_FAILED' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
        }
      }
      if (['quota-resets', 'quota-reset-history', 'quota-reset-use'].includes(action)) {
        try {
          if (attempt) throw new Error('RESET_BUSY');
          let result;
          if (action === 'quota-resets') result = await resets.list();
          else if (action === 'quota-reset-history') result = await resets.history();
          else {
            const body = await request.text();
            if (body.length > 1024) throw new Error('INVALID_RESET_REQUEST');
            let input;
            try { input = JSON.parse(body); } catch { throw new Error('INVALID_RESET_REQUEST'); }
            result = await resets.consume(input ?? {});
            await quota.read(true);
          }
          return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
        } catch (error) {
          const code = /^(RESET_HTTP_\d{3}|RESET_BUSY|RESET_FAILED|INVALID_RESET_REQUEST|INVALID_RESETS|INVALID_RESET_HISTORY|RESET_UNAVAILABLE|AUTH_REQUIRED|ACCOUNT_MISMATCH)$/.test(error?.message) ? error.message : 'RESET_FAILED';
          return Response.json({ error: code }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
        }
      }
      if (action === 'quota' || action === 'quota-refresh') {
        return Response.json(await quota.read(action === 'quota-refresh'), { headers: { 'Cache-Control': 'no-store' } });
      }
      if (action === 'speed' || action === 'reasoning-default') {
        const body = await request.text();
        if (body.length > 1024) throw new Error('INVALID_SPEED');
        const { model, tier } = JSON.parse(body);
        expireCachedCatalog();
        const row = diagnostics.rows.find(item => item.id === model && item.supported);
        if (!configured() || !row || !(action === 'speed' ? row.tiers.includes(tier) : tier === 'default' || row.efforts.includes(tier))) throw new Error('INVALID_SPEED');
        await ctx.settings.mutate(settingsNs, [{ op: 'set', path: ['providers', ROUTE, action === 'speed' ? 'speeds' : 'reasoningDefaults', model], value: tier }]);
      }
      if (action === 'login') startLogin();
      if (action === 'cancel') await cancel();
      if (action === 'logout') {
        catalogRevision++;
        await cancel();
        await resets.cancel();
        await loading?.catch(() => {});
        await catalogCache.clear();
        cacheExpiresAt = undefined;
        await quota.logout();
        // Очищаем также неиспользуемый вход SIWC от версий до 0.5.0.
        await ctx.credentials.deleteRecord(credentialKey(ROUTE, 'account'));
        available = [];
        diagnostics = { source: 'none', fetchedAt: null, rows: [], error: null };
        state = { status: 'signed-out', modelCount: 0 };
        updateProfiles();
        journal.write('info', 'logout.succeeded');
      }
      if (action === 'refresh') {
        try { await refreshCatalog(); }
        catch { state = { status: await credentials.read() ? 'stored' : 'signed-out', error: 'CATALOG_FAILED', modelCount: available.length }; }
      }
      if (action === 'apply') {
        if (!await credentials.read()) return Response.json({ ...state, error: 'AUTH_REQUIRED' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
        journal.write('info', 'settings.save.started', { settingsNs });
        await ctx.settings.mutate(settingsNs, [{ op: 'set', path: ['providers', ROUTE], value: config.providers.get()[ROUTE] ?? { speeds: {} } }]);
        journal.write('info', 'settings.save.succeeded', { settingsNs });
      }
      if (action === 'answer') {
        const body = await request.text();
        if (body.length > 8192 || !attempt?.answer) throw new Error('INVALID_ANSWER');
        const { value } = JSON.parse(body);
        if (typeof value !== 'string' || value.length > 8000) throw new Error('INVALID_ANSWER');
        attempt.answer(value);
      }
      expireCachedCatalog();
      return Response.json({ ...state, catalog: diagnostics, reasoningDefaults: config.providers.get()[ROUTE]?.reasoningDefaults ?? {}, speeds: config.providers.get()[ROUTE]?.speeds ?? {}, hasCredential: Boolean(await credentials.read()), configured: configured() }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      if (action === 'apply') journal.write('error', 'settings.save.failed', { settingsNs, detail: settingsDiagnostic(error) });
      return Response.json({ ...state, hasCredential: Boolean(await credentials.read()), error: action === 'apply' ? 'SAVE_FAILED' : failure(error), ...(action === 'apply' ? { detail: settingsDiagnostic(error) } : {}) }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }
  }
  for (const action of ['reasoning-default', 'speed', 'status', 'login', 'cancel', 'logout', 'refresh', 'apply', 'answer', 'quota', 'quota-refresh', 'quota-resets', 'quota-reset-history', 'quota-reset-use', 'quota-reset-warnings']) {
    ctx.connection.fetch.register({ path: `/api/chatgpt-codex/${action}`, methods: [['status', 'quota', 'quota-resets', 'quota-reset-history'].includes(action) ? 'GET' : 'POST'], requestBody: 'buffered', fetch: request => handle(action, request) });
  }
}
