// Передаёт в сервис диктовки только выбранную пользователем запись штатного микрофона DSH.
export async function transcribeDictation({ audio, language }, caller, getGrant) {
  const signal = AbortSignal.any([caller, AbortSignal.timeout(120000)]);
  signal.throwIfAborted();
  const grant = await getGrant(signal);
  if (!grant?.access) throw new Error('Для диктовки подключите аккаунт ChatGPT в настройках моделей.');
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'dictation.wav');
  if (language && language !== 'auto') form.append('language', language);
  const started = performance.now();
  const response = await fetch('https://chatgpt.com/backend-api/transcribe', {
    method: 'POST', redirect: 'error', signal, body: form,
    headers: { Authorization: `Bearer ${grant.access}`, 'ChatGPT-Account-Id': grant.accountId }
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Диктовка ChatGPT недоступна (HTTP ${response.status}).`);
  }
  const result = await response.json();
  if (typeof result?.text !== 'string') throw new Error('Сервис диктовки ChatGPT вернул ответ без текста.');
  // DSH проверяет канонический WAV PCM16 mono 16 кГц перед вызовом провайдера.
  return { text: result.text, audioSeconds: (audio.byteLength - 44) / 32000, inferenceSeconds: (performance.now() - started) / 1000 };
}
