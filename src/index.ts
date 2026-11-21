import path from 'node:path';
import { importAllowlistFile } from './allowlist.js';
import { createCommandHandler, parseCommand, textOf } from './commands.js';
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
import { extractFacts } from './filter.js';
import { createPipeline, formatTime } from './pipeline.js';
import { TranscriptionQueue } from './queue.js';
import { StatusFiles } from './statusfiles.js';
import { startOfDayMs, Store } from './store.js';
import { createTranscriber } from './transcriber/index.js';
import type { WAMessage } from 'baileys';
import { errorName, WhatsAppClient, type FatalReason } from './whatsapp.js';

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
  const loaded = loadConfigOrIdle();
  if (!loaded) return;
  const config: Config = loaded;

  const logger = createLogger(config.logLevel);
  const files = new StatusFiles(config.dataDir);
  files.status('מתחבר לוואטסאפ...');

  const store = new Store(config.dbFile);
  const transcriber = createTranscriber(config.transcriber);
  const queue = new TranscriptionQueue({
    concurrency: config.queueConcurrency,
    timeoutMs: TRANSCRIBE_TIMEOUT_MS,
    maxAttempts: TRANSCRIBE_MAX_ATTEMPTS,
    retryDelayMs: 2_000,
  });

  if (!config.dryRun) files.clearDryRun();
  logger.info({ dryRun: config.dryRun }, config.dryRun ? 'מצב ניסוי: שום דבר לא נשלח לוואטסאפ' : 'שליחה לוואטסאפ פעילה');

  let connectedLine = '';
  const refreshStatus = () => {
    if (!connectedLine) return;
    const dayStart = startOfDayMs(Date.now(), config.timeZone);
    const failed = store.countSince('failed', dayStart) + store.countSince('send_failed', dayStart);
    files.status(
      `${connectedLine}\n` +
        `קבוצות פעילות לתמלול: ${store.countEnabled()}${store.paused ? ' (התמלול מושהה)' : ''}\n` +
        `היום: ${store.countSince('transcribed', dayStart)} תמלולים, ${failed} כישלונות.\n` +
        (config.dryRun
          ? 'מצב ניסוי (DRY_RUN): מה שהיה נשלח נכתב ל-data/dry-run.txt ולא נשלח לוואטסאפ.\n'
          : 'שליחה פעילה: התמלולים נשלחים לוואטסאפ לפי היעד של כל קבוצה.\n') +
        "ניהול: שלח !עזרה בצ'אט שלך עם עצמך בוואטסאפ.",
    );
  };

  let idle: NodeJS.Timeout | undefined;

  const delivery = createDelivery({
    logger,
    dryRun: config.dryRun,
    timeZone: config.timeZone,
    modeOf: (jid) => store.modeOf(jid),
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
    onMessage: (msg, upsertType) => handleMessage(msg, upsertType),
    onOpen: async () => {
      files.clearPairing();
      connectedLine = 'מחובר לוואטסאפ.';
      refreshStatus();
      const groups = await whatsapp.listGroups();
      files.groups(groups);
      store.refreshNames(groups);
      const imported = importAllowlistFile(config.allowlistFile, store, (jid) => whatsapp.groupName(jid));
      if (imported > 0) logger.info({ groups: imported }, 'קבוצות יובאו מקובץ הרשימה הישן אל מסד הנתונים');
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

  const pipeline = createPipeline({
    logger,
    queue,
    transcriber,
    languageHint: config.languageHint,
    maxVoiceSec: config.maxVoiceSec,
    maxMessageAgeSec: config.maxMessageAgeSec,
    // השהיה עוצרת את כל התמלול בלי לשנות את רשימת הקבוצות
    isGroupAllowed: (jid) => !store.paused && store.isEnabled(jid),
    processed: { has: (key) => store.hasProcessed(key), add: (key) => store.addProcessed(key) },
    downloadAudio: (msg) => whatsapp.downloadAudio(msg),
    groupName: (jid) => whatsapp.groupName(jid),
    onTranscript: (result) => delivery.deliverTranscript(result),
    onOutcome: (outcome) => {
      // יומן מטא-דאטה בלבד: מזהה הודעה, מזהה קבוצה, אורך, סטטוס וזמן
      store.addJournal({
        messageId: outcome.facts.messageId,
        groupJid: outcome.facts.chatJid,
        seconds: outcome.facts.audio?.seconds ?? 0,
        status: outcome.status,
        detail: 'reason' in outcome ? outcome.reason : 'error' in outcome ? outcome.error : undefined,
      });
      if (outcome.status === 'failed') {
        // אחרי שכל הניסיונות נכשלו: שורת שגיאה לבעל החשבון, בצ'אט עם עצמו
        const time = formatTime(outcome.facts.timestampSec, config.timeZone);
        delivery
          .notifyOwner(`⚠️ תמלול נכשל: [${outcome.groupName}] ${outcome.senderName}, ${time}`)
          .catch(() => logger.error({ messageId: outcome.facts.messageId }, 'שליחת הודעת השגיאה נכשלה'));
      }
      refreshStatus();
    },
  });

  const runCommand = createCommandHandler({
    store,
    listGroups: () => whatsapp.listGroups(),
    isConnected: () => whatsapp.isConnected,
    dryRun: config.dryRun,
    timeZone: config.timeZone,
  });
  // פקודות מבוצעות אחת אחרי השנייה, לפי סדר ההגעה
  let commandChain: Promise<void> = Promise.resolve();

  function handleMessage(msg: WAMessage, upsertType: string): void {
    // פקודת ניהול: רק הודעת טקסט טרייה שבעל החשבון כתב בצ'אט עם עצמו
    if (upsertType === 'notify' && whatsapp.isOwnerSelfChat(msg)) {
      const command = parseCommand(textOf(msg) ?? '');
      const ageSec = Date.now() / 1000 - (extractFacts(msg, upsertType)?.timestampSec ?? 0);
      if (command && ageSec <= config.maxMessageAgeSec) {
        commandChain = commandChain.then(async () => {
          try {
            for (const reply of await runCommand(command)) await delivery.notifyOwner(reply);
            logger.info({ command: command.name }, 'פקודת ניהול בוצעה');
          } catch (err) {
            logger.error({ command: command.name, err: errorName(err) }, 'פקודת ניהול נכשלה');
            await delivery.notifyOwner('הפקודה נכשלה. נסה שוב בעוד רגע.').catch(() => undefined);
          }
          refreshStatus();
        });
      }
      return;
    }
    pipeline(msg, upsertType);
  }

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'כיבוי מסודר');
    connectedLine = '';
    files.status('השירות כובה.');
    whatsapp.stop();
    clearInterval(idle);
    // נותנים לתמלולים שכבר התחילו להסתיים ולהירשם ביומן, ואז סוגרים את המסד
    void queue.onIdle().then(() => store.close());
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await whatsapp.start();
}

main().catch((err: unknown) => {
  console.error('שגיאה קריטית בהפעלה: ' + (err instanceof Error ? err.name : 'UnknownError'));
  process.exit(1);
});
