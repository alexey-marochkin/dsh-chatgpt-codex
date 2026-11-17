window.__ModuleLoader__.load({ id: 'dsh-chatgpt-codex', factory: require => {
  const React = require('react');
  const { createPortal } = require('react-dom');
  const { Tooltip } = require('@deepseek-ai/dsh-client-ui-primitives');
  const h = React.createElement;
  const labels = {
    ru: { intro: 'Подключите подписку ChatGPT и выберите модель в чате.', login: 'Войти через ChatGPT', logout: 'Отключить', cancel: 'Отменить вход', refresh: 'Обновить модели', waiting: 'Завершите вход в браузере.', manual: 'Если браузер не вернулся в приложение, вставьте итоговый адрес перенаправления.', send: 'Продолжить', connected: 'Подключено. Доступных моделей: ', stored: 'Вход сохранён. Обновите список моделей.', signedOut: 'Подписка не подключена', failed: 'Не удалось завершить операцию. Повторите вход или обновление моделей.', port: 'Порт входа занят. Завершите другую попытку входа и повторите.', loading: 'Подключение…' },
    en: { intro: 'Connect your ChatGPT subscription, then choose a model in chat.', login: 'Sign in with ChatGPT', logout: 'Disconnect', cancel: 'Cancel sign-in', refresh: 'Refresh models', waiting: 'Complete sign-in in your browser.', manual: 'If the browser did not return to the app, paste the final redirect URL.', send: 'Continue', connected: 'Connected. Available models: ', stored: 'Signed in. Refresh the model list.', signedOut: 'Subscription not connected', failed: 'The operation failed. Try signing in or refreshing models again.', port: 'The sign-in port is busy. Finish the other sign-in attempt and retry.', loading: 'Connecting…' }
  };

  // Показывает лимиты только для выбранного поставщика, без опроса OpenAI у остальных моделей.
  function QuotaDock({ directory, send, language }) {
    const selection = React.useSyncExternalStore(callback => directory.subscribe(callback), () => directory.getSnapshot());
    return selection.current?.provider === 'chatgpt-codex' ? h(QuotaPanel, { send, language }) : null;
  }

  // Показывает отдельный список сбросов; первое нажатие лишь запрашивает подтверждение в выбранной строке.
  function ResetDialog({ send, language, onClose, onChanged }) {
    const ru = language === 'ru';
    const text = (r, e) => ru ? r : e;
    const [details, setDetails] = React.useState(null);
    const [tab, setTab] = React.useState('available');
    const [confirmId, setConfirmId] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [notice, setNotice] = React.useState(null);
    const [history, setHistory] = React.useState(null);
    const [historyError, setHistoryError] = React.useState(false);
    const dialog = React.useRef(null);
    const alive = React.useRef(true);
    const inFlight = React.useRef(false);
    const date = value => new Date(value).toLocaleString(ru ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });

    // Обновляет список только чтением; открытие окна и переключение вкладок ничего не расходуют.
    async function load() {
      try {
        const result = await send('quota-resets');
        if (alive.current) setDetails(result);
      } catch {
        if (alive.current) setNotice({ error: true, message: text('Не удалось загрузить список сбросов.', 'Could not load limit resets.') });
      }
    }
    // История запрашивается отдельно: недоступность журнала не превращается в пустой список событий.
    async function loadHistory() {
      setHistoryError(false);
      try {
        const result = await send('quota-reset-history');
        if (alive.current) setHistory(result);
      } catch { if (alive.current) setHistoryError(true); }
    }
    // Переключает вкладку и загружает журнал при первом открытии или после использования сброса.
    async function selectTab(value) {
      setTab(value);
      setConfirmId(null);
      if (value === 'history' && !history) await loadHistory();
    }
    React.useEffect(() => {
      alive.current = true;
      dialog.current?.showModal();
      load();
      return () => { alive.current = false; dialog.current?.close(); };
    }, [send]);

    // Отправляет расходование только после второго нажатия; блокирует двойной клик и обновляет данные.
    async function consume(creditId) {
      if (inFlight.current || confirmId !== creditId) return;
      inFlight.current = true;
      setBusy(true);
      setNotice(null);
      try {
        const result = await send('quota-reset-use', { creditId, confirmed: true });
        const messages = {
          reset: text('Лимиты сброшены.', 'Limits reset.'),
          nothing_to_reset: text('Нет лимитов, которые нужно сбросить.', 'There are no limits to reset.'),
          no_credit: text('Этот сброс больше недоступен.', 'This reset is no longer available.'),
          already_redeemed: text('Этот сброс уже использован.', 'This reset has already been used.')
        };
        if (alive.current) setNotice({ message: messages[result.code] ?? text('Обновите список, чтобы проверить результат.', 'Refresh the list to check the result.') });
      } catch {
        if (alive.current) setNotice({ error: true, message: text('Не удалось подтвердить результат. Проверьте обновлённый список перед повторной попыткой.', 'Could not confirm the result. Check the refreshed list before retrying.') });
      } finally {
        await load();
        await onChanged();
        inFlight.current = false;
        if (alive.current) { setBusy(false); setConfirmId(null); setHistory(null); }
      }
    }
    const rows = tab === 'history' ? history?.events ?? [] : details?.credits.filter(item => item.status === 'available') ?? [];
    const loaded = tab === 'history' ? history : details;
    return h('dialog', { ref: dialog, className: 'dsh-reset-dialog', 'aria-labelledby': 'dsh-reset-title', onCancel: event => { event.preventDefault(); if (!inFlight.current) onClose(); } },
      h('header', null, h('h2', { id: 'dsh-reset-title' }, text('Сброс лимита использования', 'Usage limit reset')),
        h('button', { type: 'button', className: 'dsh-reset-close', 'aria-label': text('Закрыть', 'Close'), autoFocus: true, disabled: busy, onClick: onClose }, '×')),
      h('p', { className: 'dsh-reset-description' }, text('Воспользуйтесь сбросом, чтобы восстановить 5-часовой лимит, недельный лимит или оба сразу.', 'Use a reset to restore your 5-hour limit, weekly limit, or both.')),
      h('div', { className: 'dsh-reset-card' },
        h('div', { role: 'tablist', 'aria-label': text('Сбросы лимита использования', 'Usage limit resets'), className: 'dsh-reset-tabs' },
          ...['available', 'history'].map(value => h('button', { key: value, id: `dsh-reset-tab-${value}`, type: 'button', role: 'tab', 'aria-selected': tab === value, 'aria-controls': 'dsh-reset-list', tabIndex: tab === value ? 0 : -1, disabled: busy,
            onClick: () => selectTab(value),
            onKeyDown: event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'available' : event.key === 'End' ? 'history' : tab === 'available' ? 'history' : 'available'; selectTab(next); dialog.current?.querySelector(`#dsh-reset-tab-${next}`)?.focus(); } }
          }, value === 'available' ? text('Доступно ', 'Available ') + (details?.available ?? '—') : text('История', 'History'))),
          tab === 'history' && history && h('span', { className: 'dsh-reset-period' }, text('Последние ', 'Last ') + Math.round((history.asOf - history.windowStart) / 86400000) + text(' дней', ' days'))),
        h('div', { role: 'tabpanel', id: 'dsh-reset-list', 'aria-labelledby': `dsh-reset-tab-${tab}`, tabIndex: 0 },
          tab === 'history' && historyError ? h('div', null, h('p', { role: 'alert' }, text('Не удалось загрузить историю сбросов.', 'Could not load reset history.')), h('button', { type: 'button', onClick: loadHistory }, text('Повторить', 'Retry'))) :
          !loaded ? h('p', { role: 'status' }, notice?.error ? text('Список недоступен.', 'List unavailable.') : text('Загрузка…', 'Loading…')) : !rows.length ? h('p', null, tab === 'available' ? text('Доступных сбросов нет.', 'No resets available.') : text('За этот период событий нет.', 'No events in this period.')) :
            h('table', { className: 'dsh-reset-table', 'aria-label': tab === 'available' ? text('Доступные сбросы', 'Available resets') : text('История сбросов', 'Reset history') }, h('tbody', null,
              ...rows.map(item => h('tr', { key: item.id },
                tab === 'history' ? h('td', null, h('strong', null, item.kind === 'granted' ? text('Получен сброс лимита', 'Limit reset received') : item.kind === 'used' ? text('Сброс использован', 'Reset used') : item.kind === 'expired' ? text('Срок действия сброса истёк', 'Reset expired') : text('Изменение сброса лимита', 'Limit reset updated'))) :
                h('td', null, h('strong', null, item.type === 'codex_rate_limits' ? text('Полный сброс', 'Full reset') : item.title ?? text('Сброс лимита', 'Limit reset')),
                  h('small', null, item.expiresAt === null ? text('Без срока действия', 'No expiration') : text('Срок действия истекает ', 'Expires ') + date(item.expiresAt)),
                  confirmId === item.id && h('small', { className: 'dsh-reset-confirm-note', role: 'status' }, text('Будет использован один сброс.', 'One reset will be used.'))),
                h('td', { className: 'dsh-reset-action' }, tab === 'available' ? h('div', null,
                  confirmId === item.id && h('button', { type: 'button', disabled: busy, onClick: () => setConfirmId(null) }, text('Отмена', 'Cancel')),
                  h('button', { type: 'button', className: confirmId === item.id ? 'dsh-reset-confirm' : '', disabled: busy || item.type !== 'codex_rate_limits' || (item.expiresAt !== null && item.expiresAt <= Date.now()),
                    onClick: () => confirmId === item.id ? consume(item.id) : setConfirmId(item.id)
                  }, busy && confirmId === item.id ? text('Применение…', 'Applying…') : confirmId === item.id ? text('Подтвердить', 'Confirm') : text('Использовать сброс', 'Use reset')))
                  : h('div', { className: 'dsh-reset-event-date' }, h('span', null, new Date(item.occurredAt).toLocaleDateString(ru ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'short' })), h('small', null, new Date(item.occurredAt).toLocaleTimeString(ru ? 'ru-RU' : 'en-GB', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })))))))))),
      notice && h('p', { role: notice.error ? 'alert' : 'status', className: 'dsh-reset-notice' }, notice.message),
      notice?.error && h('button', { type: 'button', disabled: busy, onClick: () => { setNotice(null); load(); } }, text('Обновить список', 'Refresh list')));
  }

  // Показывает недельный остаток и подробности серверных окон; отсутствие данных не означает полный лимит.
  function QuotaPanel({ send, language, settings = false, modelPending = false }) {
    const ru = language === 'ru';
    const text = (r, e) => ru ? r : e;
    const [state, setState] = React.useState({ status: 'loading' });
    const [open, setOpen] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [position, setPosition] = React.useState({ bottom: 45, right: 16 });
    const [resetsOpen, setResetsOpen] = React.useState(false);
    const root = React.useRef(null);
    const panel = React.useRef(null);
    const alive = React.useRef(true);
    const generation = React.useRef(0);
    React.useEffect(() => { if (modelPending || state.status === 'signed-out') setResetsOpen(false); }, [modelPending, state.status]);

    // Применяет только ответ последней операции, исключая перезапись состояния запоздалым опросом.
    async function update(action, body) {
      const revision = ++generation.current;
      try {
        const result = await send(action, body);
        if (alive.current && revision === generation.current) setState(result);
      } catch {
        if (alive.current && revision === generation.current) setState(previous => ({ ...previous, status: 'error', error: 'QUOTA_FAILED' }));
      }
    }

    React.useEffect(() => {
      alive.current = true;
      let timer;
      const poll = async () => {
        if (!document.hidden && !busy) await update('quota');
        if (alive.current) timer = setTimeout(poll, settings ? 1500 : 60000);
      };
      poll();
      const visible = () => { if (!document.hidden && !busy) update('quota'); };
      document.addEventListener('visibilitychange', visible);
      return () => { alive.current = false; generation.current++; clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
    }, [send, busy, settings, modelPending]);

    React.useLayoutEffect(() => {
      if (!open) return;
      const place = () => {
        const rect = root.current?.getBoundingClientRect();
        if (rect) setPosition({ bottom: Math.max(12, window.innerHeight - rect.top + 8), right: Math.max(12, Math.min(window.innerWidth - 340, window.innerWidth - rect.right)) });
      };
      place();
      panel.current?.querySelector('button')?.focus();
      const dismiss = event => {
        if (event.type === 'keydown' && event.key === 'Escape') { setOpen(false); root.current?.querySelector('button')?.focus(); }
        if (event.type === 'pointerdown' && !panel.current?.contains(event.target) && !root.current?.contains(event.target)) setOpen(false);
      };
      window.addEventListener('resize', place);
      document.addEventListener('keydown', dismiss);
      document.addEventListener('pointerdown', dismiss);
      return () => { window.removeEventListener('resize', place); document.removeEventListener('keydown', dismiss); document.removeEventListener('pointerdown', dismiss); };
    }, [open]);

    // Обновляет лимиты по явному действию в настройках.
    async function act(action) {
      setBusy(true);
      await update(action);
      if (alive.current) setBusy(false);
    }
    const data = state.data;
    const weekly = data?.weekly;
    const stale = state.status === 'error' || (state.fetchedAt && Date.now() - state.fetchedAt > 120000) || (weekly?.resetsAt && weekly.resetsAt * 1000 <= Date.now());
    const percent = weekly && !stale ? weekly.remainingPercent : null;
    const formatPercent = number => new Intl.NumberFormat(ru ? 'ru' : 'en', { maximumFractionDigits: 1 }).format(number) + '%';
    const date = seconds => seconds ? new Date(seconds * 1000).toLocaleString(ru ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }) : text('не указано', 'not provided');
    const period = seconds => seconds === 604800 ? text('Неделя', 'Weekly') : seconds % 86400 === 0 ? `${seconds / 86400} ${text('дн.', 'days')}` : seconds % 3600 === 0 ? `${seconds / 3600} ${text('ч', 'hours')}` : `${Math.round(seconds / 60)} ${text('мин', 'min')}`;
    const caption = text('Неделя: ', 'Weekly: ') + (percent === null ? '—' : formatPercent(percent));
    if (settings) return h('section', { className: 'dsh-quota-settings', 'aria-label': text('Лимиты подписки', 'Plan limits') },
      h('div', { className: 'dsh-quota-heading' },
        h('strong', null, text('Лимиты подписки', 'Plan limits'))),
      h('div', { className: 'dsh-quota-status' },
        h('span', { role: 'status' }, modelPending ? text('Завершите вход в браузере.', 'Complete sign-in in your browser.') : state.status === 'connected' ? caption : state.status === 'loading' || state.status === 'stored' ? text('Загрузка…', 'Loading…') : state.status === 'signed-out' ? text('Войдите в ChatGPT.', 'Sign in to ChatGPT.') : text('Не удалось обновить лимиты. Повторите попытку.', 'Could not refresh limits. Try again.')),
        h(Tooltip, { label: text('Обновить лимиты', 'Refresh limits'), side: 'top', delayMs: 200, portal: true },
          h('button', { type: 'button', className: 'dsh-quota-refresh', 'aria-label': text('Обновить лимиты', 'Refresh limits'), 'aria-busy': busy, disabled: busy || modelPending || state.status === 'signed-out', onClick: () => act('quota-refresh') },
            // Готовая иконка Lucide RefreshCw; лицензия включена в LICENSE-LUCIDE.
            h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
              h('path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }),
              h('path', { d: 'M21 3v5h-5' }),
              h('path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }),
              h('path', { d: 'M8 16H3v5' }))))),
      h('div', { className: 'dsh-reset-summary' },
        h('span', null, text('Доступно сбросов: ', 'Available resets: ') + (stale ? '—' : data?.resetsAvailable ?? '—')),
        h('button', { type: 'button', disabled: modelPending || state.status === 'signed-out' || state.status === 'loading', 'aria-haspopup': 'dialog', onClick: () => setResetsOpen(true) }, text('Посмотреть', 'View'))),
      h('a', { href: 'https://chatgpt.com/settings/usage', target: '_blank', rel: 'noopener noreferrer' }, text('Управление подпиской и лимитами', 'Manage plan and limits')),
      resetsOpen && h(ResetDialog, { send, language, onClose: () => setResetsOpen(false), onChanged: () => update('quota-refresh') }));
    return h('span', { ref: root, className: 'dsh-quota-anchor' },
      h(Tooltip, { label: text('Остаток недельного лимита ChatGPT', 'ChatGPT weekly limit remaining'), side: 'top', delayMs: 200, disabled: open, portal: true },
      h('button', { type: 'button', className: 'dsh-quota-pill', 'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-label': text('Остаток недельного лимита ChatGPT', 'ChatGPT weekly limit remaining'), onClick: () => { setOpen(!open); if (!open) update('quota'); } },
        h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true },
          h('circle', { cx: 8, cy: 8, r: 6, fill: 'none', stroke: 'currentColor', strokeWidth: 2, opacity: 0.25 }),
          percent !== null && h('circle', { cx: 8, cy: 8, r: 6, fill: 'none', stroke: 'currentColor', strokeWidth: 2, pathLength: 100, strokeDasharray: `${percent} 100`, transform: 'rotate(-90 8 8)' })), caption)),
      open && createPortal(h('section', { ref: panel, className: 'dsh-quota-panel', role: 'dialog', 'aria-label': text('Лимиты ChatGPT', 'ChatGPT limits'), style: position },
        h('header', null, h('strong', null, 'ChatGPT', data?.plan ? ` · ${data.plan}` : ''), h('button', { type: 'button', 'aria-label': text('Закрыть', 'Close'), onClick: () => { setOpen(false); root.current?.querySelector('button')?.focus(); } }, '×')),
        h('p', { className: 'dsh-quota-note' }, text('Остаток лимитов Codex в подписке ChatGPT.', 'Remaining Codex limits in your ChatGPT plan.')),
        state.status === 'loading' && h('p', { role: 'status' }, text('Загрузка…', 'Loading…')),
        state.error && h('p', { role: 'alert' }, text('Не удалось обновить данные. Проверьте подключение в настройках ChatGPT - Codex.', 'Could not update limits. Check the ChatGPT - Codex connection in settings.')),
        stale && data && h('p', { role: 'status' }, text('Ниже последние полученные данные; они могли измениться.', 'Last known values below; these may have changed.')),
        data && h('div', null,
          ...data.windows.map(item => h('div', { key: item.id, className: 'dsh-quota-window' },
            h('div', null, h('span', null, `${item.name} · ${period(item.seconds)}`), h('strong', null, text('Осталось ', 'Remaining ') + formatPercent(item.remainingPercent))),
            h('progress', { value: item.remainingPercent, max: 100, 'aria-label': `${item.name} ${period(item.seconds)}` }),
            h('small', null, text('Обновление: ', 'Resets: ') + date(item.resetsAt)))),
          !weekly && h('p', null, text('Недельный лимит сервер не передал.', 'The server did not provide a weekly limit.')),
          data.individual && h('p', null, text('Личный лимит: осталось ', 'Individual limit: remaining ') + formatPercent(data.individual.remainingPercent) + ' · ' + date(data.individual.resetsAt)),
          (data.allowed === false || data.spendControlReached) && h('p', { role: 'status' }, text('Достигнуто ограничение использования.', 'A usage limit has been reached.')),
          data.credits && h('p', null, text('Кредиты: ', 'Credits: ') + (data.credits.unlimited ? text('без ограничений', 'unlimited') : data.credits.balance ?? text('не указано', 'not provided'))),
          data.resetsAvailable !== null && h('p', null, text('Доступно сбросов лимита: ', 'Available limit resets: ') + data.resetsAvailable)),
        !data && h('p', null, text('Подключение лимитов: Настройки → Модели → ChatGPT - Codex → Редактировать.', 'Connect limits in Settings → Models → ChatGPT - Codex → Edit.')),
        data && h('footer', { className: 'dsh-quota-fetched' }, text('Получено: ', 'Fetched: ') + date(state.fetchedAt / 1000) + (state.account ? text(' · Аккаунт …', ' · Account …') + state.account : ''))
      ), document.body)
    );
  }

  // Показывает состояние подписки и действия; секреты никогда не запрашиваются у Host.
  function Panel({ send, language, configured }) {
    const t = labels[language] ?? labels.en;
    const [state, setState] = React.useState({ status: 'loading' });
    const [busy, setBusy] = React.useState(false);
    const [value, setValue] = React.useState('');
    const root = React.useRef(null);
    const [badgeTarget, setBadgeTarget] = React.useState(null);
    const [footerTarget, setFooterTarget] = React.useState(null);
    const [actionError, setActionError] = React.useState(null);
    const browserRequested = React.useRef(false);
    React.useLayoutEffect(() => {
      setBadgeTarget(root.current?.closest('li.jrmgQW_rowCard')?.querySelector('.jrmgQW_rowIdentity') ?? null);
      setFooterTarget(root.current?.closest('.jrmgQW_addPanel, .jrmgQW_rowCard')?.querySelector(':scope > .jrmgQW_editor .jrmgQW_editorActions') ?? null);
    });
    React.useEffect(() => {
      let alive = true;
      let timer;
      const poll = async () => {
        try { const next = await send('status'); if (alive) setState(next); }
        catch { if (alive) setState({ status: 'error' }); }
        if (alive) timer = setTimeout(poll, 1500);
      };
      poll();
      return () => { alive = false; clearTimeout(timer); };
    }, [send]);

    // Открывает системный браузер один раз после получения OAuth-адреса, только по нажатию входа здесь.
    React.useEffect(() => {
      if (state.status !== 'signing-in' || !state.url || !browserRequested.current) return;
      browserRequested.current = false;
      window.open(state.url, '_blank', 'noopener,noreferrer');
    }, [state.status, state.url]);

    // Отправляет явное действие пользователя и очищает введённый callback после передачи.
    async function act(action) {
      setBusy(true);
      setActionError(null);
      if (action === 'login') browserRequested.current = true;
      if (action === 'cancel') browserRequested.current = false;
      try {
        const next = await send(action, action === 'answer' ? { value } : undefined);
        setState(next);
        if (action === 'answer') setValue('');
        if (action === 'apply') footerTarget?.querySelector('.jrmgQW_secondaryButton')?.click();
      } catch (error) { browserRequested.current = false; setActionError(error.result ?? { error: 'REQUEST_FAILED' }); }
      finally { setBusy(false); }
    }
    const pending = state.status === 'signing-in';
    const hasCredential = state.hasCredential ?? ['connected', 'stored'].includes(state.status);
    const button = (action, text, disabled = false) => h('button', { type: 'button', disabled: busy || disabled, onClick: () => act(action), style: { padding: '7px 12px', border: '1px solid var(--dsw-alias-border-l3, #777)', borderRadius: 6, background: action === 'apply' ? 'var(--dsw-alias-button-primary-fill)' : 'transparent', color: action === 'apply' ? 'var(--dsw-alias-label-primary-foreground)' : 'inherit', cursor: 'pointer' } }, text);
    const applyButton = button('apply', language === 'ru' ? 'Применить' : 'Apply', !['connected', 'stored'].includes(state.status));
    const message = state.status === 'connected' ? t.connected + state.modelCount : state.status === 'stored' ? t.stored : pending ? t.waiting : state.status === 'signed-out' ? t.signedOut : state.status === 'loading' ? t.loading : state.error === 'PORT_BUSY' ? t.port : t.failed;
    const signedIn = state.status === 'connected';
    const badgeText = signedIn ? (language === 'ru' ? 'Вошёл в систему' : 'Signed in') : state.status === 'stored' || state.status === 'loading' ? t.loading : t.signedOut;
    const badge = h('span', { role: 'status', style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: signedIn ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)' } },
      h('span', { 'aria-hidden': true, style: { width: 8, height: 8, borderRadius: '50%', background: signedIn ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' } }), badgeText);
    return h('section', { ref: root, className: 'dsh-chatgpt-codex', 'aria-label': 'ChatGPT - Codex' },
      badgeTarget && createPortal(badge, badgeTarget),
      h('p', null, t.intro),
      h('p', { role: 'status', 'aria-live': 'polite' }, message),
      actionError && h('p', { role: 'alert' }, actionError.error === 'SAVE_FAILED' ? (language === 'ru' ? 'Вход сохранён, но не удалось применить настройки: ' : 'Signed in, but settings could not be saved: ') + (actionError.detail ?? 'SAVE_FAILED') : t.failed),
      h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, pending ? button('cancel', t.cancel) : hasCredential ? button('logout', t.logout) : button('login', t.login, state.status === 'loading'), !pending && hasCredential && button('refresh', t.refresh)),
      footerTarget ? createPortal(applyButton, footerTarget) : applyButton,
      pending && h('details', { style: { marginTop: 12 } }, h('summary', null, t.manual), h('input', { type: 'password', 'aria-label': t.manual, autoComplete: 'off', value, onChange: event => setValue(event.target.value), style: { width: '100%', margin: '8px 0' } }), button('answer', t.send)),
      h(QuotaPanel, { send, language, settings: true, modelPending: pending })
    );
  }

  // Встраивает коннектор в штатную страницу моделей, используя транспорт Electron или Web.
  function apply(ctx) {
    // В DSH rc.3 слот дополняет универсальный редактор; убираем его заглушку только у нашей карточки.
    ctx.effect(() => {
      const style = document.createElement('style');
      style.textContent = `
        .jrmgQW_addPanel:has(.dsh-chatgpt-codex) > .jrmgQW_editor { order: 2; }
        :is(.jrmgQW_addPanel, .jrmgQW_rowCard):has(.dsh-chatgpt-codex) > .jrmgQW_editor > :not(.jrmgQW_editorActions),
        :is(.jrmgQW_addPanel, .jrmgQW_rowCard):has(.dsh-chatgpt-codex) > .jrmgQW_editor .jrmgQW_primaryButton { display: none; }
        .jrmgQW_rowCard:has(.dsh-chatgpt-codex):not(:has(> .jrmgQW_editor)) .dsh-chatgpt-codex { display: none; }
        .dsh-chatgpt-codex { color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; }
        .dsh-chatgpt-codex p { margin: 0 0 12px; }
        .dsh-quota-anchor { display: inline-flex; }
        .dsh-quota-pill { display: inline-flex; align-items: center; gap: 6px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-tertiary, #aaa); padding: 2px 6px; font-family: inherit; font-size: var(--dsh-content-font-size-secondary, 13px); white-space: nowrap; cursor: pointer; }
        .dsh-quota-pill:hover { color: var(--dsw-alias-label-primary, #eee); background: var(--dsw-alias-interactive-bg-hover); }
        .dsh-quota-panel { position: fixed; z-index: 1000; box-sizing: border-box; width: 340px; max-width: calc(100vw - 24px); max-height: 70vh; overflow: auto; padding: 18px; border: 1px solid var(--dsw-alias-border-l3, #555); border-radius: 14px; background: var(--dsw-specific-menu, #29292c); color: var(--dsw-alias-label-primary, #eee); backdrop-filter: var(--dsw-menu-backdrop-filter); box-shadow: var(--dsw-elevation-prominent); font-size: 13px; line-height: 1.5; }
        .dsh-quota-panel header, .dsh-quota-window > div { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
        .dsh-quota-panel header strong { font-size: 16px; }
        .dsh-quota-panel p { margin: 10px 0; }
        .dsh-quota-panel button { border: 1px solid var(--dsw-alias-border-l3, #555); border-radius: 6px; background: transparent; color: inherit; padding: 5px 9px; font: inherit; cursor: pointer; }
        .dsh-quota-panel button:disabled { opacity: .5; cursor: wait; }
        .dsh-quota-panel a { color: var(--dsw-alias-label-link, #a99aff); }
        .dsh-quota-panel button:focus-visible, .dsh-quota-pill:focus-visible { outline: 2px solid var(--dsw-alias-label-link, #a99aff); outline-offset: 2px; }
        .dsh-quota-window { margin: 14px 0; }
        .dsh-quota-window strong { white-space: nowrap; }
        .dsh-quota-window progress { display: block; width: 100%; height: 6px; margin: 7px 0; accent-color: var(--dsw-alias-state-success-primary, #30b861); }
        .dsh-quota-note, .dsh-quota-window small { color: var(--dsw-alias-label-tertiary, #aaa); }
        .dsh-quota-fetched { margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-tertiary); font-size: 11px; }
        .dsh-quota-panel input { box-sizing: border-box; width: 100%; margin: 8px 0; }
        .dsh-quota-settings { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--dsw-alias-border-l3); }
        .dsh-quota-heading { margin-bottom: 8px; }
        .dsh-quota-status { display: flex; align-items: center; gap: 4px; margin-bottom: 12px; }
        .dsh-quota-settings .dsh-quota-refresh { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; width: 26px; height: 26px; padding: 0; border: 0; }
        .dsh-quota-refresh:hover { background: var(--dsw-alias-interactive-bg-hover); }
        .dsh-quota-refresh:focus-visible { outline: 2px solid var(--dsw-alias-label-link); outline-offset: 2px; }
        .dsh-quota-settings button { padding: 7px 12px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
        .dsh-quota-settings button:disabled { opacity: .5; cursor: default; }
        .dsh-reset-summary { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
        .dsh-reset-dialog { box-sizing: border-box; width: 660px; max-width: calc(100vw - 32px); max-height: calc(100vh - 48px); overflow: auto; margin: auto; padding: 24px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 20px; background: var(--dsw-alias-bg-module-platform, #29292c); color: var(--dsw-alias-label-primary); box-shadow: var(--dsw-elevation-prominent); font: inherit; }
        .dsh-reset-dialog::backdrop { background: #0008; }
        .dsh-reset-dialog header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 8px; }
        .dsh-reset-dialog h2 { margin: 0; font-size: 20px; line-height: 1.3; }
        .dsh-reset-dialog .dsh-reset-close { border: 0; padding: 2px 8px; font-size: 24px; }
        .dsh-reset-dialog .dsh-reset-description { color: var(--dsw-alias-label-tertiary); margin: 0 0 20px; }
        .dsh-reset-card { border: 1px solid var(--dsw-alias-border-l3); border-radius: 16px; padding: 14px 16px; }
        .dsh-reset-tabs { display: flex; gap: 6px; margin-bottom: 14px; }
        .dsh-reset-period { margin-left: auto; align-self: center; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
        .dsh-reset-event-date { flex-direction: column; align-items: flex-end; gap: 0; white-space: nowrap; }
        .dsh-reset-tabs [role=tab] { border: 0; border-radius: 10px; color: var(--dsw-alias-label-tertiary); font-weight: 600; }
        .dsh-reset-tabs [aria-selected=true] { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover, #171717); }
        .dsh-reset-table { width: 100%; border-collapse: collapse; }
        .dsh-reset-table td { padding: 16px 0; border-top: 1px solid var(--dsw-alias-border-l3); vertical-align: middle; }
        .dsh-reset-table strong, .dsh-reset-table small { display: block; }
        .dsh-reset-table small { color: var(--dsw-alias-label-tertiary); margin-top: 3px; font-size: 12px; }
        .dsh-reset-table .dsh-reset-confirm-note { color: var(--dsw-alias-label-primary); }
        .dsh-reset-table .dsh-reset-action { width: 1%; padding-left: 16px; }
        .dsh-reset-action > div { display: flex; gap: 6px; justify-content: flex-end; }
        .dsh-reset-action button { white-space: nowrap; border: 0; border-radius: 12px; background: var(--dsw-alias-interactive-bg-hover, #333); }
        .dsh-reset-action .dsh-reset-confirm { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
        .dsh-reset-dialog .dsh-reset-notice { margin: 14px 0 0; }
        .dsh-reset-dialog button:focus-visible, .dsh-reset-summary button:focus-visible { outline: 2px solid var(--dsw-alias-label-link); outline-offset: 2px; }
        @media (max-width: 560px) { .dsh-reset-dialog { padding: 16px; } .dsh-reset-table tr, .dsh-reset-table td { display: block; } .dsh-reset-table .dsh-reset-action { width: auto; border-top: 0; padding: 0 0 14px; } .dsh-reset-action > div { justify-content: flex-start; } }
      `;
      document.head.appendChild(style);
      return () => style.remove();
    });
    const send = async (action, body) => {
      const transport = globalThis.__DSH_TRANSPORT__?.fetch ?? globalThis.fetch.bind(globalThis);
      const response = await transport(`api/chatgpt-codex/${action}`, { method: ['status', 'quota', 'quota-resets', 'quota-reset-history'].includes(action) ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error('CONNECTOR_REQUEST_FAILED'), { result });
      return result;
    };
    ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
      name: 'settings.models.provider-card', id: 'chatgpt-codex', key: 'chatgpt-codex',
      inject: () => ({ send, language: (document.documentElement.lang || navigator.language).startsWith('ru') ? 'ru' : 'en' })
    }, Panel));
    ctx.inject(['modelDirectories'], scope => scope.slots.inject('conversation.composer.dock', () => scope.slots.register({
      name: 'conversation.composer.dock', id: 'chatgpt-codex-quota', order: 2,
      inject: sessionId => ({ directory: scope.modelDirectories.directoryFor(sessionId).store, send, language: (document.documentElement.lang || navigator.language).startsWith('ru') ? 'ru' : 'en' })
    }, QuotaDock)));
  }
  return { apply, inject: ['slots', 'connection'] };
} });
