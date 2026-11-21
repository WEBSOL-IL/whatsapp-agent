import { ConfigError, loadConfig } from './config.js';
import { createBaileysLogger, createLogger } from './logger.js';
import { WhatsAppClient } from './whatsapp.js';

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
  let groupsPrinted = false;

  const whatsapp = new WhatsAppClient({
    authDir: config.authDir,
    pairingPhone: config.pairingPhone,
    logger,
    baileysLogger: createBaileysLogger(config.baileysLogLevel),
    onOpen: async () => {
      if (groupsPrinted) return;
      const groups = await whatsapp.listGroups();
      groupsPrinted = true;
      // פלט למסוף לצורך הגדרה, לא ללוג: שמות ומזהי קבוצות בלבד
      const lines = groups.map((g, i) => `${String(i + 1).padStart(3)}. ${g.name}\n     ${g.jid}`);
      process.stdout.write(`\nקבוצות (${groups.length}):\n${lines.join('\n')}\n\n`);
    },
    onFatal: () => {
      process.exitCode = 1;
    },
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'כיבוי מסודר');
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
