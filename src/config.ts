import { existsSync } from 'node:fs';
import path from 'node:path';
import type { TranscriberConfig } from './transcriber/index.js';

export interface Config {
  /** תיקיית פרטי ההתחברות לוואטסאפ. שווה לגישה מלאה לחשבון. */
  authDir: string;
  /** מספר טלפון לצימוד בקוד (ספרות בלבד, פורמט בינלאומי). ריק = צימוד ב-QR. */
  pairingPhone: string | undefined;
  /** תיקיית הנתונים: קבצי מצב עכשיו, ובהמשך גם קובץ ה-SQLite. */
  dataDir: string;
  /** קובץ הקבוצות המאושרות (שלבים 2-3). */
  allowlistFile: string;
  transcriber: TranscriberConfig;
  /** רמז שפה למנוע התמלול (למשל he). undefined = זיהוי אוטומטי. */
  languageHint: string | undefined;
  /** תקרת אורך להודעה קולית, בשניות. */
  maxVoiceSec: number;
  /** הודעה ישנה מזה נחשבת היסטוריה ולא מתומללת. */
  maxMessageAgeSec: number;
  queueConcurrency: number;
  /**
   * מצב ניסוי: מה שהיה נשלח לוואטסאפ מודפס ונכתב ל-data/dry-run.txt במקום להישלח.
   * ברירת המחדל היא true, ושליחה אמיתית דורשת DRY_RUN=false מפורש.
   */
  dryRun: boolean;
  /** אזור הזמן להצגת שעת ההודעה. */
  timeZone: string;
  logLevel: string;
  baileysLogLevel: string;
}

/** זמן מרבי לניסיון תמלול אחד, ומספר הניסיונות הכולל (ראשון ועוד אחד חוזר). */
export const TRANSCRIBE_TIMEOUT_MS = 60_000;
export const TRANSCRIBE_MAX_ATTEMPTS = 2;

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];

export class ConfigError extends Error {}

function readLogLevel(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = (env[name] ?? '').trim().toLowerCase() || fallback;
  if (!LOG_LEVELS.includes(value)) {
    throw new ConfigError(`${name} חייב להיות אחד מ: ${LOG_LEVELS.join(', ')}`);
  }
  return value;
}

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = (env[name] ?? '').trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} חייב להיות מספר שלם בין ${min} ל-${max}`);
  }
  return value;
}

function readBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = (env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new ConfigError(`${name} חייב להיות true או false`);
}

function readTranscriber(env: NodeJS.ProcessEnv): TranscriberConfig {
  const provider = (env.TRANSCRIBER ?? '').trim().toLowerCase() || 'cloud';
  if (provider === 'local') return { provider: 'local' };
  if (provider !== 'cloud') throw new ConfigError('TRANSCRIBER חייב להיות cloud או local');

  const apiKey = (env.TRANSCRIBE_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new ConfigError('חסר TRANSCRIBE_API_KEY: מפתח ה-API של שירות התמלול. יש להוסיף אותו לקובץ .env');
  }
  const baseUrl = (env.TRANSCRIBE_API_BASE_URL ?? '').trim() || 'https://api.openai.com/v1';
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ConfigError('TRANSCRIBE_API_BASE_URL אינו כתובת תקינה');
  }
  if (parsed.protocol !== 'https:') {
    throw new ConfigError('TRANSCRIBE_API_BASE_URL חייב להתחיל ב-https://');
  }
  const responseFormat = (env.TRANSCRIBE_RESPONSE_FORMAT ?? '').trim() || 'verbose_json';
  if (responseFormat !== 'verbose_json' && responseFormat !== 'json') {
    throw new ConfigError('TRANSCRIBE_RESPONSE_FORMAT חייב להיות verbose_json או json');
  }
  return {
    provider: 'cloud',
    cloud: { baseUrl, apiKey, model: (env.TRANSCRIBE_MODEL ?? '').trim() || 'whisper-1', responseFormat },
  };
}

/** פונקציה טהורה: מקבלת את משתני הסביבה ומחזירה הגדרות מאומתות, או זורקת ConfigError. */
export function parseConfig(env: NodeJS.ProcessEnv, cwd: string = process.cwd()): Config {
  const pairingRaw = (env.PAIRING_PHONE ?? '').trim();
  if (pairingRaw && !/^[1-9]\d{7,14}$/.test(pairingRaw)) {
    // בכוונה לא מדפיסים את הערך עצמו
    throw new ConfigError('PAIRING_PHONE חייב להיות ספרות בלבד בפורמט בינלאומי, בלי + ובלי רווחים (למשל 9725XXXXXXXX)');
  }

  const dataDir = path.resolve(cwd, (env.DATA_DIR ?? '').trim() || 'data');
  const languageHint = (env.TRANSCRIBE_LANGUAGE ?? '').trim().toLowerCase();
  if (languageHint && !/^[a-z]{2,3}$/.test(languageHint)) {
    throw new ConfigError('TRANSCRIBE_LANGUAGE חייב להיות קוד שפה קצר (למשל he), או ריק לזיהוי אוטומטי');
  }
  const timeZone = (env.TIMEZONE ?? '').trim() || 'Asia/Jerusalem';
  try {
    new Intl.DateTimeFormat('he-IL', { timeZone });
  } catch {
    throw new ConfigError('TIMEZONE אינו אזור זמן תקין (למשל Asia/Jerusalem)');
  }

  return {
    authDir: path.resolve(cwd, (env.AUTH_DIR ?? '').trim() || 'auth'),
    pairingPhone: pairingRaw || undefined,
    dataDir,
    allowlistFile: path.resolve(dataDir, 'allowed-groups.txt'),
    transcriber: readTranscriber(env),
    languageHint: languageHint || undefined,
    maxVoiceSec: readInt(env, 'MAX_VOICE_SECONDS', 600, 1, 7200),
    maxMessageAgeSec: readInt(env, 'MAX_MESSAGE_AGE_SECONDS', 60, 5, 3600),
    queueConcurrency: readInt(env, 'QUEUE_CONCURRENCY', 2, 1, 2),
    dryRun: readBool(env, 'DRY_RUN', true),
    timeZone,
    logLevel: readLogLevel(env, 'LOG_LEVEL', 'info'),
    baileysLogLevel: readLogLevel(env, 'BAILEYS_LOG_LEVEL', 'silent'),
  };
}

/** טוען את .env (אם קיים) בלי תלות חיצונית, ומחזיר הגדרות מאומתות. */
export function loadConfig(): Config {
  const envFile = path.resolve(process.cwd(), '.env');
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
  return parseConfig(process.env);
}
