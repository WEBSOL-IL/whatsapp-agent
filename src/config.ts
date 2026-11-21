import { existsSync } from 'node:fs';
import path from 'node:path';

export interface Config {
  /** תיקיית פרטי ההתחברות לוואטסאפ. שווה לגישה מלאה לחשבון. */
  authDir: string;
  /** מספר טלפון לצימוד בקוד (ספרות בלבד, פורמט בינלאומי). ריק = צימוד ב-QR. */
  pairingPhone: string | undefined;
  /** תיקיית הנתונים: קבצי מצב עכשיו, ובהמשך גם קובץ ה-SQLite. */
  dataDir: string;
  logLevel: string;
  baileysLogLevel: string;
}

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];

export class ConfigError extends Error {}

function readLogLevel(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = (env[name] ?? '').trim().toLowerCase() || fallback;
  if (!LOG_LEVELS.includes(value)) {
    throw new ConfigError(`${name} חייב להיות אחד מ: ${LOG_LEVELS.join(', ')}`);
  }
  return value;
}

/** פונקציה טהורה: מקבלת את משתני הסביבה ומחזירה הגדרות מאומתות, או זורקת ConfigError. */
export function parseConfig(env: NodeJS.ProcessEnv, cwd: string = process.cwd()): Config {
  const pairingRaw = (env.PAIRING_PHONE ?? '').trim();
  if (pairingRaw && !/^[1-9]\d{7,14}$/.test(pairingRaw)) {
    // בכוונה לא מדפיסים את הערך עצמו
    throw new ConfigError('PAIRING_PHONE חייב להיות ספרות בלבד בפורמט בינלאומי, בלי + ובלי רווחים (למשל 9725XXXXXXXX)');
  }

  return {
    authDir: path.resolve(cwd, (env.AUTH_DIR ?? '').trim() || 'auth'),
    pairingPhone: pairingRaw || undefined,
    dataDir: path.resolve(cwd, (env.DATA_DIR ?? '').trim() || 'data'),
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
