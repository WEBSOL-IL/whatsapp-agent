import type { Transcriber, TranscriptionResult } from './index.js';

export interface CloudTranscriberOptions {
  /** כתובת הבסיס של API תואם OpenAI, למשל https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * verbose_json מחזיר גם שפה ואורך. לא כל מודל תומך בו,
   * ולכן אפשר לעבור ל-json (טקסט בלבד) בהגדרות.
   */
  responseFormat: 'verbose_json' | 'json';
}

/** שגיאת ספק התמלול. כוללת רק קוד סטטוס, בלי גוף התשובה. */
export class TranscriptionApiError extends Error {
  constructor(readonly status: number) {
    super(`transcription API returned HTTP ${status}`);
    this.name = 'TranscriptionApiError';
  }
}

/**
 * תמלול דרך שירות ענן תואם Whisper (נקודת הקצה audio/transcriptions של OpenAI
 * והספקים התואמים לה). האודיו נשלח מהזיכרון ולא נכתב לדיסק.
 *
 * הודעות קוליות בוואטסאפ הן OGG/Opus. הספקים התואמים מקבלים את הפורמט ישירות,
 * ולכן אין כאן המרה עם ffmpeg. אם ספק מסוים ידחה OGG, כאן המקום להוסיף אותה.
 */
export class CloudTranscriber implements Transcriber {
  private readonly endpoint: string;

  constructor(private readonly opts: CloudTranscriberOptions) {
    this.endpoint = opts.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions';
  }

  async transcribe(
    audio: Buffer,
    mimeType: string,
    languageHint?: string,
    signal?: AbortSignal,
  ): Promise<TranscriptionResult> {
    const form = new FormData();
    // הספקים מזהים את הפורמט לפי סיומת שם הקובץ
    const type = mimeType.split(';')[0]!.trim() || 'audio/ogg';
    form.append('file', new Blob([new Uint8Array(audio)], { type }), 'voice.' + extensionFor(type));
    form.append('model', this.opts.model);
    form.append('response_format', this.opts.responseFormat);
    if (languageHint) form.append('language', languageHint);

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      body: form,
      signal,
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new TranscriptionApiError(response.status);
    }

    const body = (await response.json()) as { text?: unknown; language?: unknown; duration?: unknown };
    return {
      text: typeof body.text === 'string' ? body.text.trim() : '',
      language: typeof body.language === 'string' && body.language ? body.language : (languageHint ?? 'unknown'),
      durationSec: typeof body.duration === 'number' ? body.duration : 0,
    };
  }
}

function extensionFor(type: string): string {
  switch (type) {
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/mp4':
    case 'audio/aac':
      return 'm4a';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    case 'audio/webm':
      return 'webm';
    default:
      return 'ogg';
  }
}
