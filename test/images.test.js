import test from 'node:test';
import assert from 'node:assert/strict';
import { generateImage } from '../images.js';

// Проверяет подписочный маршрут и сохранение полученного PNG средствами DSH.
test('создаёт PNG через подписку текущего аккаунта', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const result = await generateImage({ prompt: 'Маяк', filename: '../Маяк в тумане.PNG' }, { signal: new AbortController().signal, callId: 'call' }, {
    getGrant: async () => ({ access: 'example', accountId: 'account' }),
    request: async (url, options) => {
      assert.equal(url, 'https://chatgpt.com/backend-api/codex/images/generations');
      assert.equal(options.headers['ChatGPT-Account-Id'], 'account');
      assert.equal(JSON.parse(options.body).model, 'gpt-image-2');
      return Response.json({ data: [{ b64_json: png.toString('base64') }] });
    },
    attachments: { imageLimits: { maxImageBytes: 16, maxMessageImageBytes: 32 }, saveImage: image => image }
  });
  assert.deepEqual(result.data, png);
  assert.equal(result.mediaType, 'image/png');
  assert.equal(result.name, 'Маяк в тумане.png');
});

test('при отказе в доступе возвращает статус сервиса', async () => {
  await assert.rejects(generateImage({ prompt: 'Маяк' }, {}, {
    getGrant: async () => ({ access: 'example', accountId: 'account' }),
    request: async () => new Response(null, { status: 403 })
  }), /HTTP 403/);
});
