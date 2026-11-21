import { CloudTranscriber, type CloudTranscriberOptions } from './cloud.js';
import { LocalTranscriber } from './local.js';

export interface TranscriptionResult {
  text: string;
  /** קוד השפה שזוהתה, או 'unknown' אם המנוע לא מדווח. */
  language: string;
  /** אורך האודיו לפי המנוע, או 0 אם המנוע לא מדווח. */
  durationSec: number;
}

/** הממשק האחיד למנוע התמלול. שאר הקוד מכיר רק אותו. */
export interface Transcriber {
  transcribe(
    audio: Buffer,
    mimeType: string,
    languageHint?: string,
    /** הרחבה אופציונלית מעבר לאפיון: מאפשרת לתור לבטל בקשה שפג זמנה. */
    signal?: AbortSignal,
  ): Promise<TranscriptionResult>;
}

export type TranscriberConfig = { provider: 'cloud'; cloud: CloudTranscriberOptions } | { provider: 'local' };

export function createTranscriber(config: TranscriberConfig): Transcriber {
  switch (config.provider) {
    case 'cloud':
      return new CloudTranscriber(config.cloud);
    case 'local':
      return new LocalTranscriber();
  }
}
