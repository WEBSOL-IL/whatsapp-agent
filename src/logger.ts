import { pino, type Logger } from 'pino';

/**
 * לוג האפליקציה. כלל ברזל: לא כותבים לכאן תוכן הודעות, שמות שולחים או מספרי טלפון.
 * מותר: מזהי הודעות, מזהי קבוצות, אורכים, סטטוסים וזמנים.
 */
export function createLogger(level: string): Logger {
  return pino({ level, base: undefined, timestamp: pino.stdTimeFunctions.isoTime });
}

/**
 * הלוג הפנימי של Baileys כולל מזהי משתמשים (מספרי טלפון) ברמות הנמוכות,
 * ולכן הוא כבוי כברירת מחדל ונפתח רק לצורך דיבוג נקודתי.
 */
export function createBaileysLogger(level: string): Logger {
  return pino({ level, base: undefined, timestamp: pino.stdTimeFunctions.isoTime }).child({ lib: 'baileys' });
}

export type { Logger };
