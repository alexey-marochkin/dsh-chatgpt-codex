// Дополняет встроенный каталог описаниями Pi (earendil-works/pi, cead615b); встроенная запись всегда приоритетна.
export function withExperimentalModels(native) {
  const models = [...native];
  for (const [id, contextWindow, input, output, cacheRead, cacheWrite] of [
    ['gpt-6.2-astra', 272000, 8, 40, 0.4, 10],
    ['gpt-6.2-sol', 500000, 2, 10, 0.1, 2.5],
    ['gpt-6.1-terra', 500000, 1, 5, 0.05, 1.25]
  ]) {
    if (native.some(model => model.id === id)) continue;
    models.push({ id, name: id, experimental: true, type: 'chat', provider: 'openai-codex', api: 'openai-codex-responses',
      baseUrl: 'https://chatgpt.com/backend-api', input: ['text', 'image'], contextWindow, maxTokens: 128000, reasoning: true,
      thinkingLevelMap: { off: id === 'gpt-6.1-terra' ? 'none' : null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
      compat: { supportsOpenAIGrammarTools: true, supportsAdditionalTools: true, supportsToolSearch: true, supportsMidConvoSystemMessages: true },
      inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 } } },
      cost: { input, output, cacheRead, cacheWrite, tiers: [{ inputTokensAbove: 272000, input: input * 2, output: output * 1.5, cacheRead: cacheRead * 2, cacheWrite: cacheWrite * 2 }] }
    });
  }
  return models;
}

const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// Пересекает явно объявленные сервером усилия с уровнями, которые передаёт установленный pi-ai.
export function reasoningLevels(entry, known) {
  if (!Array.isArray(entry?.supported_reasoning_levels) || !known?.reasoning) return [];
  const advertised = entry.supported_reasoning_levels.map(item => item?.effort);
  return LEVELS.filter(level => advertised.includes(level) && known.thinkingLevelMap?.[level] !== null
    && (!(level === 'xhigh' || level === 'max') || known.thinkingLevelMap?.[level] !== undefined)
    && (known.thinkingLevelMap?.[level] ?? level) === level);
}

// Показывает только видимые модели и известные режимы, объявленные сервером для каждой модели.
export function catalogRows(catalog, known) {
  const rows = new Map();
  for (const model of catalog?.models ?? []) {
    if (model?.visibility !== 'list' || typeof model.slug !== 'string') continue;
    const advertised = Array.isArray(model.service_tiers) ? model.service_tiers.map(tier => tier?.id) : [];
    if (!advertised.length && Array.isArray(model.additional_speed_tiers) && model.additional_speed_tiers.includes('fast')) advertised.push('priority');
    const tiers = ['default', ...['priority', 'fast', 'ultrafast'].filter(tier => advertised.includes(tier))];
    const descriptor = known.find(item => item.id === model.slug);
    rows.set(model.slug, { id: model.slug, supported: Boolean(descriptor), ...(descriptor?.experimental ? { experimental: true } : {}), tiers, efforts: reasoningLevels(model, descriptor) });
  }
  return [...rows.values()];
}

// Добавляет скорость после преобразований streamSimple, сохраняя штатный транспорт и обработчик payload.
export function speedProvider(provider, resolveSpeed) {
  return { ...provider, streamSimple(model, context, options) {
    const tier = resolveSpeed(model.id);
    return provider.streamSimple(model, context, { ...options, onPayload: async (body, requestModel) => {
      const payload = await options?.onPayload?.(body, requestModel) ?? body;
      return { ...payload, service_tier: tier };
    } });
  } };
}
