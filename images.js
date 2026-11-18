const endpoint = 'https://chatgpt.com/backend-api/codex/images/generations';
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');

// Читает JSON частями и ограничивает объём до декодирования base64 по лимиту вложений DSH.
async function readPng(response, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > Math.ceil(limit / 3) * 4 + 1024 * 1024) throw new Error('Изображение превышает лимит вложений DSH.');
    chunks.push(chunk);
  }
  const encoded = JSON.parse(Buffer.concat(chunks).toString('utf8')).data?.[0]?.b64_json;
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'base64') > limit) throw new Error('Codex вернул недопустимые данные изображения.');
  const data = Buffer.from(encoded, 'base64');
  if (!data.subarray(0, 8).equals(pngSignature)) throw new Error('Codex вернул изображение в неожиданном формате.');
  return data;
}

// Сохраняет выбранное моделью имя, убирая пути, служебные символы и зарезервированные имена Windows.
function pngName(filename = '') {
  let stem = filename.split(/[\\/]/).pop().normalize('NFC').replace(/\.(png|jpe?g|webp|gif)$/i, '')
    .replace(/[<>:"|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, '-').trim();
  stem = Array.from(stem).slice(0, 90).join('').replace(/^[. ]+|[. ]+$/g, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(stem)) stem = '_' + stem;
  return (stem || 'codex-image') + '.png';
}

// Выполняет один подписочный запрос и возвращает штатную ссылку на вложение DSH.
export async function generateImage({ prompt, filename, quality = 'auto', background = 'auto' }, exec, { getGrant, attachments, request = fetch }) {
  if (!prompt.trim()) throw new Error('Укажите описание изображения.');
  const grant = await getGrant(exec.signal);
  if (!grant?.access || !grant.accountId) throw new Error('Войдите в ChatGPT в настройках ChatGPT - Codex.');
  const response = await request(endpoint, {
    method: 'POST', redirect: 'error', signal: exec.signal,
    headers: { Authorization: `Bearer ${grant.access}`, 'ChatGPT-Account-Id': grant.accountId,
      'Content-Type': 'application/json', Accept: 'application/json', originator: 'pi', 'x-codex-image-turn-id': String(exec.callId) },
    body: JSON.stringify({ model: 'gpt-image-2', prompt, quality, background, size: 'auto' })
  });
  if (!response.ok) {
    await response.body?.cancel();
    const reason = { 401: 'Требуется повторный вход в ChatGPT.', 403: 'Сервис отклонил доступ к генерации.', 429: 'Достигнут лимит запросов генерации.' };
    throw new Error(`Codex Images (HTTP ${response.status}). ${reason[response.status] ?? 'Не удалось создать изображение.'}`);
  }
  const limits = attachments.imageLimits;
  const data = await readPng(response, Math.min(limits.maxImageBytes, limits.maxMessageImageBytes));
  exec.signal.throwIfAborted();
  return attachments.saveImage({ data, mediaType: 'image/png', name: pngName(filename) });
}
