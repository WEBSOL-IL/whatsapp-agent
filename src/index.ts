import { ConfigError, loadConfig } from './config.js';
import { createBaileysLogger, createLogger } from './logger.js';
import { StatusFiles } from './statusfiles.js';
import { WhatsAppClient, type FatalReason } from './whatsapp.js';

const FATAL_TEXT: Record<FatalReason, string> = {
  logged_out: 'המכשיר נותק מהחשבון. יש למחוק את תיקיית auth, להפעיל מחדש ולצמד שוב.',
  replaced: 'תהליך אחר משתמש באותה תיקיית auth. יש לוודא שרץ רק תהליך אחד.',
  forbidden: 'וואטסאפ דחה את החיבור (403). ייתכן שהחשבון נחסם.',
};

// כל קובץ שהתהליך יוצר (auth/, data/) נגיש למשתמש המריץ בלבד
process.umask(0o077);

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error('שגיאת הגדרות: ' + err.message);
      process.exit(2);
    }
    throw err;
  }

  const logger = createLogger(config.logLevel);
  const files = new StatusFiles(config.dataDir);
  files.status('מתחבר לוואטסאפ...');
  let groupsPrinted = false;

  const whatsapp = new WhatsAppClient({
    authDir: config.authDir,
    pairingPhone: config.pairingPhone,
    logger,
    baileysLogger: createBaileysLogger(config.baileysLogLevel),
    onQr: (qr) => files.pairingQr(qr),
    onPairingCode: (code) => files.pairingCode(code),
    onReconnecting: (statusCode) => files.status(`החיבור נסגר (קוד ${statusCode ?? 'לא ידוע'}), מנסה להתחבר מחדש...`),
    onOpen: async () => {
      files.clearPairing();
      files.status('מחובר לוואטסאפ.');
      if (groupsPrinted) return;
      const groups = await whatsapp.listGroups();
      groupsPrinted = true;
      files.groups(groups);
      files.status(`מחובר לוואטסאפ. ${groups.length} קבוצות, הרשימה ב-data/groups.txt.`);
      // פלט למסוף לצורך הגדרה, לא ללוג: שמות ומזהי קבוצות בלבד
      const lines = groups.map((g, i) => `${String(i + 1).padStart(3)}. ${g.name}\n     ${g.jid}`);
      process.stdout.write(`\nקבוצות (${groups.length}):\n${lines.join('\n')}\n\n`);
    },
    onFatal: (reason) => {
      files.status('נעצר: ' + FATAL_TEXT[reason]);
      process.exitCode = 1;
    },
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'כיבוי מסודר');
    files.status('השירות כובה.');
    whatsapp.stop();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await whatsapp.start();
}

main().catch((err: unknown) => {
  console.error('שגיאה קריטית בהפעלה: ' + (err instanceof Error ? err.name : 'UnknownError'));
  process.exit(1);
});
