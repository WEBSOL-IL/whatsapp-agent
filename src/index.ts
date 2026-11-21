import path from 'node:path';
import { FileAllowlist } from './allowlist.js';
import {
  ConfigError,
  loadConfig,
  resolveStateDir,
  TRANSCRIBE_MAX_ATTEMPTS,
  TRANSCRIBE_TIMEOUT_MS,
  type Config,
} from './config.js';
import { createDelivery } from './delivery.js';
import { createBaileysLogger, createLogger } from './logger.js';
import { createPipeline, formatTime, MemoryProcessedStore } from './pipeline.js';
import { TranscriptionQueue } from './queue.js';
import { StatusFiles } from './statusfiles.js';
import { createTranscriber } from './transcriber/index.js';
import { WhatsAppClient, type FatalReason } from './whatsapp.js';

const FATAL_TEXT: Record<FatalReason, string> = {
  logged_out: 'המכשיר נותק מהחשבון והסשן נמחק. הפעל מחדש את התהליך כדי לצמד שוב.',
  pairing_timeout: 'הצימוד לא הושלם בזמן. הפעל מחדש את התהליך כדי לקבל קוד חדש.',
  replaced: 'תהליך אחר משתמש באותה תיקיית auth. יש לוודא שרץ רק תהליך אחד.',
  forbidden: 'וואטסאפ דחה את החיבור (403). ייתכן שהחשבון נחסם.',
};

// כל קובץ שהתהליך יוצר (auth/, data/) נגיש למשתמש המריץ בלבד
process.umask(0o077);

/**
 * נשארים במצב המתנה במקום לצאת: יציאה הייתה גורמת למנהל התהליכים להפעיל מחדש
 * בלולאה, בלי שמישהו טיפל בבעיה.
 */
function idleUntilSignal(): void {
  const timer = setInterval(() => undefined, 60 * 60 * 1000);
  const exit = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.once('SIGINT', exit);
  process.once('SIGTERM', exit);
}

function loadConfigOrIdle(): Config | undefined {
  try {
    return loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error('שגיאת הגדרות: ' + err.message);
    const stateDir = resolveStateDir(process.env);
    const dataDir = path.resolve(stateDir, (process.env.DATA_DIR ?? '').trim() || 'data');
    new StatusFiles(dataDir).status(
      'שגיאת הגדרות, השירות לא פועל:\n' + err.message + `\nתקן את הקובץ ${path.join(stateDir, '.env')} והפעל מחדש.`,
    );
    idleUntilSignal();
    return undefined;
  }
}

async function main(): Promise<void> {
  const config = loadConfigOrIdle();
  if (!config) return;

  const logger = createLogger(config.logLevel);
  const files = new StatusFiles(config.dataDir);
  files.status('מתחבר לוואטסאפ...');

  const allowlist = new FileAllowlist(config.allowlistFile, (count, invalidLines) => {
    logger.info({ groups: count, invalidLines }, 'רשימת הקבוצות המאושרות נטענה');
  });
  const transcriber = createTranscriber(config.transcriber);
  const queue = new TranscriptionQueue({
    concurrency: config.queueConcurrency,
    timeoutMs: TRANSCRIBE_TIMEOUT_MS,
    maxAttempts: TRANSCRIBE_MAX_ATTEMPTS,
    retryDelayMs: 2_000,
  });

  if (!config.dryRun) files.clearDryRun();
  logger.info({ dryRun: config.dryRun }, config.dryRun ? 'מצב ניסוי: שום דבר לא נשלח לוואטסאפ' : 'שליחה לוואטסאפ פעילה');

  const counters = { transcribed: 0, failed: 0 };
  let connectedLine = '';
  const refreshStatus = () => {
    if (!connectedLine) return;
    files.status(
      `${connectedLine}\n` +
        `קבוצות מאושרות לתמלול: ${allowlist.size} (data/allowed-groups.txt)\n` +
        `מאז ההפעלה: ${counters.transcribed} תמלולים, ${counters.failed} כישלונות.\n` +
        (config.dryRun
          ? 'מצב ניסוי (DRY_RUN): מה שהיה נשלח נכתב ל-data/dry-run.txt ולא נשלח לוואטסאפ.'
          : 'שליחה פעילה: התמלולים נשלחים לוואטסאפ לפי היעד של כל קבוצה.'),
    );
  };

  let idle: NodeJS.Timeout | undefined;

  const delivery = createDelivery({
    logger,
    dryRun: config.dryRun,
    timeZone: config.timeZone,
    modeOf: (jid) => allowlist.modeOf(jid),
    sendToSelf: (text) => whatsapp.sendToSelf(text),
    replyInGroup: (original, text) => whatsapp.replyInGroup(original, text),
    onDryRun: (description) => {
      process.stdout.write(`\n${description}\n\n`);
      files.dryRun(description);
    },
  });

  const whatsapp: WhatsAppClient = new WhatsAppClient({
    authDir: config.authDir,
    pairingPhone: config.pairingPhone,
    logger,
    baileysLogger: createBaileysLogger(config.baileysLogLevel),
    onQr: (qr) => files.pairingQr(qr),
    onPairingCode: (code) => files.pairingCode(code),
    onReconnecting: (statusCode) => {
      connectedLine = '';
      files.status(`החיבור נסגר (קוד ${statusCode ?? 'לא ידוע'}), מנסה להתחבר מחדש...`);
    },
    onMessage: createPipeline({
      logger,
      queue,
      transcriber,
      languageHint: config.languageHint,
      maxVoiceSec: config.maxVoiceSec,
      maxMessageAgeSec: config.maxMessageAgeSec,
      isGroupAllowed: (jid) => allowlist.has(jid),
      processed: new MemoryProcessedStore(),
      downloadAudio: (msg) => whatsapp.downloadAudio(msg),
      groupName: (jid) => whatsapp.groupName(jid),
      onTranscript: (result) => delivery.deliverTranscript(result),
      onOutcome: (outcome) => {
        if (outcome.status === 'transcribed') counters.transcribed++;
        if (outcome.status === 'failed' || outcome.status === 'send_failed') counters.failed++;
        if (outcome.status === 'failed') {
          // אחרי שכל הניסיונות נכשלו: שורת שגיאה לבעל החשבון, בצ'אט עם עצמו
          const time = formatTime(outcome.facts.timestampSec, config.timeZone);
          delivery
            .notifyOwner(`⚠️ תמלול נכשל: [${outcome.groupName}] ${outcome.senderName}, ${time}`)
            .catch(() => logger.error({ messageId: outcome.facts.messageId }, 'שליחת הודעת השגיאה נכשלה'));
        }
        refreshStatus();
      },
    }),
    onOpen: async () => {
      files.clearPairing();
      connectedLine = 'מחובר לוואטסאפ.';
      refreshStatus();
      const groups = await whatsapp.listGroups();
      files.groups(groups);
      connectedLine = `מחובר לוואטסאפ. ${groups.length} קבוצות, הרשימה ב-data/groups.txt.`;
      refreshStatus();
    },
    onFatal: (reason) => {
      connectedLine = '';
      files.clearPairing();
      files.status('נעצר: ' + FATAL_TEXT[reason]);
      idle = setInterval(() => undefined, 60 * 60 * 1000);
    },
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'כיבוי מסודר');
    connectedLine = '';
    files.status('השירות כובה.');
    whatsapp.stop();
    clearInterval(idle);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await whatsapp.start();
}

main().catch((err: unknown) => {
  console.error('שגיאה קריטית בהפעלה: ' + (err instanceof Error ? err.name : 'UnknownError'));
  process.exit(1);
});
