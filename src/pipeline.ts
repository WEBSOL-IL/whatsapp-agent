import type { WAMessage } from 'baileys';
import { decide, extractFacts, type MessageFacts, type SkipReason } from './filter.js';
import type { Logger } from './logger.js';
import { TaskFailedError, type TranscriptionQueue } from './queue.js';
import type { Transcriber } from './transcriber/index.js';

/** תמלול מוכן, עם מה שצריך כדי להציג או לשלוח אותו. */
export interface TranscriptReady {
  facts: MessageFacts;
  message: WAMessage;
  groupName: string;
  senderName: string;
  text: string;
  language: string;
}

export interface PipelineDeps {
  logger: Logger;
  queue: TranscriptionQueue;
  transcriber: Transcriber;
  languageHint: string | undefined;
  maxVoiceSec: number;
  maxMessageAgeSec: number;
  isGroupAllowed: (groupJid: string) => boolean;
  /** מזהי הודעות שטופלו. */
  processed: { has(key: string): boolean; add(key: string): void };
  downloadAudio: (msg: WAMessage) => Promise<Buffer>;
  groupName: (groupJid: string) => string;
  /** מה עושים עם תמלול מוכן. בשלב 2: הדפסה בלבד. */
  onTranscript: (result: TranscriptReady) => void | Promise<void>;
  /** אירוע מטא-דאטה בלבד (בלי תוכן), ליומן ולסטטוס. */
  onOutcome?: (outcome: Outcome) => void;
  now?: () => number;
}

export type Outcome =
  | { status: 'transcribed'; facts: MessageFacts; elapsedMs: number }
  | { status: 'empty'; facts: MessageFacts }
  | { status: 'failed'; facts: MessageFacts; error: string }
  | { status: 'skipped'; facts: MessageFacts; reason: SkipReason };

/** סיבות דילוג ששווה לרשום ביומן. השאר הן רעש: רוב ההודעות אינן קוליות בקבוצה מאושרת. */
const LOGGED_SKIPS: ReadonlySet<SkipReason> = new Set(['too_long', 'too_old', 'not_realtime', 'duplicate']);

/**
 * מסלול הטיפול בהודעה: סינון, ורק אם עברה אותו, הורדה לזיכרון ותמלול דרך התור.
 * הלוג כולל מטא-דאטה בלבד: מזהה הודעה, מזהה קבוצה, אורך, סטטוס וזמן.
 */
export function createPipeline(deps: PipelineDeps): (msg: WAMessage, upsertType: string) => void {
  const now = deps.now ?? Date.now;

  return (msg, upsertType) => {
    const facts = extractFacts(msg, upsertType);
    if (!facts) return;

    const decision = decide(facts, {
      nowMs: now(),
      maxAgeSec: deps.maxMessageAgeSec,
      maxVoiceSec: deps.maxVoiceSec,
      isGroupAllowed: deps.isGroupAllowed,
      isProcessed: (key) => deps.processed.has(key),
    });

    const meta = { messageId: facts.messageId, groupId: facts.chatJid, seconds: facts.audio?.seconds };

    if (decision.action === 'skip') {
      // רושמים רק דילוג על הודעה קולית בקבוצה מאושרת
      const isRelevantVoice = facts.audio?.isVoiceNote && deps.isGroupAllowed(facts.chatJid);
      if (isRelevantVoice && LOGGED_SKIPS.has(decision.reason)) {
        deps.logger.info({ ...meta, reason: decision.reason }, 'הודעה קולית דולגה');
        deps.onOutcome?.({ status: 'skipped', facts, reason: decision.reason });
      }
      return;
    }

    // רושמים את המזהה לפני העבודה, כדי שאירוע חוזר על אותה הודעה לא יתמלל פעמיים
    deps.processed.add(decision.dedupKey);
    const startedAt = now();
    const mimeType = facts.audio!.mimeType;

    void deps.queue
      .add(async (signal) => {
        // האודיו חי רק בתוך הניסיון הזה, ומשתחרר מהזיכרון כשהוא מסתיים
        const audio = await deps.downloadAudio(msg);
        signal.throwIfAborted();
        return deps.transcriber.transcribe(audio, mimeType, deps.languageHint, signal);
      })
      .then(async (result) => {
        if (!hasSpeech(result.text)) {
          deps.logger.info({ ...meta, status: 'empty' }, 'תמלול ריק, לא נשלח');
          deps.onOutcome?.({ status: 'empty', facts });
          return;
        }
        const elapsedMs = now() - startedAt;
        deps.logger.info({ ...meta, status: 'transcribed', language: result.language, elapsedMs }, 'הודעה תומללה');
        await deps.onTranscript({
          facts,
          message: msg,
          groupName: deps.groupName(facts.chatJid),
          senderName: facts.fromMe ? 'אני' : msg.pushName?.trim() || 'לא ידוע',
          text: result.text,
          language: result.language,
        });
        deps.onOutcome?.({ status: 'transcribed', facts, elapsedMs });
      })
      .catch((err: unknown) => {
        const error = describeError(err);
        deps.logger.error({ ...meta, status: 'failed', error }, 'התמלול נכשל');
        deps.onOutcome?.({ status: 'failed', facts, error });
      });
  };
}

/** תמלול ריק או של סימני פיסוק בלבד נחשב רעש ולא נשלח. */
export function hasSpeech(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/** תיאור שגיאה ללוג: שם וקוד בלבד, בלי הודעות חופשיות שעלולות לכלול תוכן או מזהים. */
function describeError(err: unknown): string {
  const inner = err instanceof TaskFailedError ? err.lastError : err;
  if (!(inner instanceof Error)) return 'UnknownError';
  const status = (inner as { status?: unknown }).status;
  return typeof status === 'number' ? `${inner.name}(${status})` : inner.name;
}

/** פורמט ההודעה במצב פרטי: [שם הקבוצה] שם השולח, 19:52 ובשורה הבאה התמלול. */
export function formatPrivate(t: TranscriptReady, timeZone: string): string {
  const time = new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(
    new Date(t.facts.timestampSec * 1000),
  );
  return `[${t.groupName}] ${t.senderName}, ${time}\n${t.text}`;
}

/** מזהי הודעות שטופלו, בזיכרון. בשלב 4 יוחלף בטבלה ב-SQLite. */
export class MemoryProcessedStore {
  private readonly keys = new Set<string>();

  constructor(private readonly maxSize = 5000) {}

  has(key: string): boolean {
    return this.keys.has(key);
  }

  add(key: string): void {
    this.keys.add(key);
    if (this.keys.size > this.maxSize) {
      // Set שומר סדר הכנסה, אז הראשון הוא הישן ביותר
      this.keys.delete(this.keys.values().next().value!);
    }
  }
}
