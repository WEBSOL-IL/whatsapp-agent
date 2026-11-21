import type { Transcriber, TranscriptionResult } from './index.js';

/**
 * TODO: מנוע תמלול מקומי (whisper.cpp או faster-whisper), כך שהאודיו לא עוזב את המכונה.
 *
 * מה צריך לממש כאן:
 * 1. המרת OGG/Opus ל-WAV 16kHz מונו עם ffmpeg, דרך stdin/stdout בלבד
 *    (אודיו בזיכרון בלבד, בלי קבצים זמניים על הדיסק).
 * 2. הרצת המנוע על האודיו המומר. עדיף תהליך שרת מקומי של whisper.cpp שנשאר טעון,
 *    כדי לא לטעון את המודל מחדש לכל הודעה.
 * 3. בחירת מודל: לשקול מודל עברית ייעודי (פרויקט ivrit.ai) ולהשוות מול מודל הענן
 *    על 10 הודעות אמיתיות, כפי שמופיע בשאלה הפתוחה באפיון.
 * 4. הגדרות ב-.env: נתיב המודל, נתיב ffmpeg, מספר threads.
 * 5. כיבוד ה-signal: הריגת תהליך ההמרה והתמלול כשפג הזמן.
 *
 * עד אז, בחירה ב-TRANSCRIBER=local נכשלת בהפעלה עם הודעה ברורה.
 */
export class LocalTranscriber implements Transcriber {
  constructor() {
    throw new Error('מנוע התמלול המקומי עדיין לא מומש. יש להגדיר TRANSCRIBER=cloud');
  }

  transcribe(_audio: Buffer, _mimeType: string, _languageHint?: string): Promise<TranscriptionResult> {
    return Promise.reject(new Error('not implemented'));
  }
}
