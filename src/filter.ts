/**
 * כללי הסינון. פונקציות טהורות בלבד: בלי רשת, בלי דיסק, בלי שעון.
 * הסדר הוא הסדר שבאפיון, והסינון לפי קבוצה קורה לפני שמורידים או מתמללים משהו.
 */

/** המינימום שצריך לדעת על הודעה כדי להחליט. המבנה תואם להודעה של Baileys. */
export interface IncomingMessage {
  key?: { remoteJid?: string | null; id?: string | null; fromMe?: boolean | null } | null;
  messageTimestamp?: number | { toNumber(): number } | null;
  message?: MessageContent | null;
}

interface AudioContent {
  ptt?: boolean | null;
  seconds?: number | null;
  mimetype?: string | null;
}

interface MessageContent {
  audioMessage?: AudioContent | null;
  ephemeralMessage?: { message?: MessageContent | null } | null;
}

export interface MessageFacts {
  chatJid: string;
  messageId: string;
  fromMe: boolean;
  /** 'notify' = הודעה חדשה בזמן אמת. כל ערך אחר = סנכרון היסטוריה. */
  upsertType: string;
  timestampSec: number;
  /** קיים רק אם להודעה יש תוכן אודיו. */
  audio: { isVoiceNote: boolean; seconds: number; mimeType: string } | undefined;
}

export interface FilterContext {
  nowMs: number;
  /** הודעה ישנה מזה נחשבת היסטוריה ונזרקת. */
  maxAgeSec: number;
  /** תקרת אורך להודעה קולית. */
  maxVoiceSec: number;
  /** האם הקבוצה ברשימה המאושרת. */
  isGroupAllowed: (groupJid: string) => boolean;
  /** האם מזהה ההודעה כבר טופל. */
  isProcessed: (dedupKey: string) => boolean;
}

export type SkipReason =
  | 'not_realtime'
  | 'too_old'
  | 'not_group'
  | 'group_not_allowed'
  | 'not_audio'
  | 'not_voice_note'
  | 'too_long'
  | 'duplicate';

export type FilterDecision = { action: 'process'; dedupKey: string } | { action: 'skip'; reason: SkipReason };

const GROUP_SUFFIX = '@g.us';
/** סטיית שעון מותרת בין השרת לוואטסאפ, כדי שהודעה "מהעתיד" לא תיפסל. */
const CLOCK_SKEW_SEC = 30;

function toSeconds(ts: IncomingMessage['messageTimestamp']): number {
  if (typeof ts === 'number') return ts;
  if (ts && typeof ts.toNumber === 'function') return ts.toNumber();
  return 0;
}

/** שולף מהודעה גולמית את העובדות שהסינון צריך. מחזיר undefined אם אין לה מזהים. */
export function extractFacts(msg: IncomingMessage, upsertType: string): MessageFacts | undefined {
  const chatJid = msg.key?.remoteJid;
  const messageId = msg.key?.id;
  if (!chatJid || !messageId) return undefined;

  // בקבוצה עם הודעות נעלמות התוכן עטוף ב-ephemeralMessage.
  // הודעת "צפייה חד-פעמית" בכוונה לא נפתחת: היא לא מתומללת.
  const content = msg.message?.ephemeralMessage?.message ?? msg.message;
  const audio = content?.audioMessage;

  return {
    chatJid,
    messageId,
    fromMe: Boolean(msg.key?.fromMe),
    upsertType,
    timestampSec: toSeconds(msg.messageTimestamp),
    audio: audio
      ? {
          isVoiceNote: audio.ptt === true,
          seconds: audio.seconds ?? 0,
          mimeType: audio.mimetype || 'audio/ogg; codecs=opus',
        }
      : undefined,
  };
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith(GROUP_SUFFIX);
}

/** מפתח הכפילות: מזהה הודעה ייחודי רק בתוך צ'אט, ולכן משלבים את שניהם. */
export function dedupKeyOf(facts: Pick<MessageFacts, 'chatJid' | 'messageId'>): string {
  return `${facts.chatJid}|${facts.messageId}`;
}

/** סינון טריות: רק הודעות שהגיעו בזמן אמת, ולא ישנות מהסף. */
export function checkFreshness(facts: MessageFacts, ctx: FilterContext): SkipReason | undefined {
  if (facts.upsertType !== 'notify') return 'not_realtime';
  const ageSec = ctx.nowMs / 1000 - facts.timestampSec;
  if (ageSec > ctx.maxAgeSec || ageSec < -CLOCK_SKEW_SEC) return 'too_old';
  return undefined;
}

/** סינון קבוצה: רק צ'אט קבוצתי שנמצא ברשימה המאושרת. */
export function checkGroup(facts: MessageFacts, ctx: FilterContext): SkipReason | undefined {
  if (!isGroupJid(facts.chatJid)) return 'not_group';
  if (!ctx.isGroupAllowed(facts.chatJid)) return 'group_not_allowed';
  return undefined;
}

/** סינון סוג: רק הקלטה קולית מתוך וואטסאפ (ptt), ורק מתחת לתקרת האורך. */
export function checkVoice(facts: MessageFacts, ctx: FilterContext): SkipReason | undefined {
  if (!facts.audio) return 'not_audio';
  if (!facts.audio.isVoiceNote) return 'not_voice_note';
  if (facts.audio.seconds > ctx.maxVoiceSec) return 'too_long';
  return undefined;
}

/** מניעת כפילות: הודעה שכבר טופלה לא מטופלת שוב. הרישום עצמו נעשה אצל הקורא. */
export function checkDuplicate(facts: MessageFacts, ctx: FilterContext): SkipReason | undefined {
  return ctx.isProcessed(dedupKeyOf(facts)) ? 'duplicate' : undefined;
}

/** מריץ את כל הכללים לפי הסדר ומחזיר החלטה אחת. */
export function decide(facts: MessageFacts, ctx: FilterContext): FilterDecision {
  const reason =
    checkFreshness(facts, ctx) ?? checkGroup(facts, ctx) ?? checkVoice(facts, ctx) ?? checkDuplicate(facts, ctx);
  return reason ? { action: 'skip', reason } : { action: 'process', dedupKey: dedupKeyOf(facts) };
}
