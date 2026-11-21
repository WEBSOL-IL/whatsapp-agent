import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { CloudTranscriber, TranscriptionApiError } from './cloud.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const options = { baseUrl: 'https://api.example.test/v1/', apiKey: 'sk-test', model: 'm1', responseFormat: 'verbose_json' as const };

describe('CloudTranscriber', () => {
  it('שולח בקשה תואמת Whisper ומפענח את התשובה', async () => {
    let seen: { url: string; auth: string | null; form: FormData } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), auth: new Headers(init?.headers).get('authorization'), form: init?.body as FormData };
      return Response.json({ text: ' שלום ', language: 'hebrew', duration: 4.2 });
    }) as typeof fetch;

    const result = await new CloudTranscriber(options).transcribe(Buffer.from([1, 2, 3]), 'audio/ogg; codecs=opus', 'he');

    assert.deepEqual(result, { text: 'שלום', language: 'hebrew', durationSec: 4.2 });
    assert.equal(seen!.url, 'https://api.example.test/v1/audio/transcriptions');
    assert.equal(seen!.auth, 'Bearer sk-test');
    assert.equal(seen!.form.get('model'), 'm1');
    assert.equal(seen!.form.get('language'), 'he');
    assert.equal(seen!.form.get('response_format'), 'verbose_json');
    const file = seen!.form.get('file') as File;
    assert.equal(file.name, 'voice.ogg');
    assert.equal(file.type, 'audio/ogg');
    assert.equal(file.size, 3);
  });

  it('בלי רמז שפה לא נשלח שדה language, ותשובה בלי שפה מחזירה unknown', async () => {
    let form: FormData | undefined;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      form = init?.body as FormData;
      return Response.json({ text: 'hi' });
    }) as typeof fetch;
    const result = await new CloudTranscriber(options).transcribe(Buffer.from([1]), 'audio/ogg');
    assert.equal(form!.has('language'), false);
    assert.deepEqual(result, { text: 'hi', language: 'unknown', durationSec: 0 });
  });

  it('תשובת שגיאה זורקת TranscriptionApiError עם קוד בלבד, בלי גוף התשובה', async () => {
    globalThis.fetch = (async () => new Response('{"error":"quota for sk-test"}', { status: 429 })) as typeof fetch;
    await assert.rejects(
      new CloudTranscriber(options).transcribe(Buffer.from([1]), 'audio/ogg'),
      (err: unknown) => err instanceof TranscriptionApiError && err.status === 429 && !err.message.includes('sk-test'),
    );
  });
});
