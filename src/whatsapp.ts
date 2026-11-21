import { chmod, mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WASocket,
} from 'baileys';
import QRCode from 'qrcode';
import type { Logger } from './logger.js';

export interface GroupInfo {
  jid: string;
  name: string;
}

export interface WhatsAppOptions {
  authDir: string;
  pairingPhone: string | undefined;
  logger: Logger;
  baileysLogger: Logger;
  /** קוד QR חדש לסריקה (מתחלף כל כמה עשרות שניות). */
  onQr?: (qr: string) => void | Promise<void>;
  /** קוד צימוד להקלדה בטלפון. */
  onPairingCode?: (code: string) => void | Promise<void>;
  /** החיבור נסגר ומתבצע ניסיון חוזר. */
  onReconnecting?: (statusCode: number | undefined) => void;
  /** נקרא בכל פעם שהחיבור נפתח (גם אחרי התחברות מחדש). */
  onOpen?: () => void | Promise<void>;
  /** נקרא כשהחיבור נסגר סופית ואין טעם לנסות שוב בלי התערבות ידנית. */
  onFatal?: (reason: FatalReason) => void;
}

export type FatalReason = 'logged_out' | 'replaced' | 'forbidden';

const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

/**
 * חיבור לוואטסאפ כמכשיר מקושר דרך Baileys.
 * בשלב 1 המחלקה רק מתחברת וקוראת את רשימת הקבוצות. היא לא שולחת שום הודעה.
 */
export class WhatsAppClient {
  private sock: WASocket | undefined;
  private stopped = false;
  private connected = false;
  private reconnectAttempt = 0;
  private readonly stopSignal = new AbortController();

  constructor(private readonly opts: WhatsAppOptions) {}

  get isConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    // התיקייה שווה לגישה מלאה לחשבון: קריאה וכתיבה למשתמש המריץ בלבד
    await mkdir(this.opts.authDir, { recursive: true, mode: 0o700 });
    await chmod(this.opts.authDir, 0o700);
    await this.connect();
  }

  /** סוגר את החיבור בלי לנתק את המכשיר המקושר (לא קוראים ל-logout). */
  stop(): void {
    this.stopped = true;
    this.connected = false;
    this.stopSignal.abort(); // מבטל המתנה להתחברות מחדש, כדי שהתהליך ייצא מיד
    this.sock?.end(undefined);
    this.sock = undefined;
  }

  /** כל הקבוצות שהחשבון חבר בהן, ממוינות לפי שם. */
  async listGroups(): Promise<GroupInfo[]> {
    if (!this.sock || !this.connected) {
      throw new Error('אין חיבור פעיל לוואטסאפ');
    }
    const groups = await this.sock.groupFetchAllParticipating();
    return Object.values(groups)
      .map((g) => ({ jid: g.id, name: g.subject || '(ללא שם)' }))
      .sort((a, b) => a.name.localeCompare(b.name, 'he'));
  }

  private async connect(): Promise<void> {
    const { logger, baileysLogger, authDir, pairingPhone } = this.opts;
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const usePairingCode = Boolean(pairingPhone) && !state.creds.registered;

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      logger: baileysLogger,
      // צימוד בקוד דורש זהות דפדפן "הגיונית" לפי התיעוד
      browser: Browsers.macOS('Google Chrome'),
      // לא מסמנים את החשבון כמחובר, כדי שהטלפון ימשיך לקבל התראות
      markOnlineOnConnect: false,
      syncFullHistory: false,
      // לא שומרים תוכן הודעות, ולכן אין מה להחזיר לבקשות שליחה חוזרת
      getMessage: async () => undefined,
    });
    this.sock = sock;

    let pairingRequested = false;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      void (async () => {
        if (sock !== this.sock) return; // אירוע מאוחר של חיבור ישן
        const { connection, lastDisconnect, qr } = update;

        if (qr && !usePairingCode) {
          const art = await QRCode.toString(qr, { type: 'terminal', small: true });
          process.stdout.write(
            '\nסרוק את הקוד בטלפון: וואטסאפ > הגדרות > מכשירים מקושרים > קישור מכשיר\n\n' + art + '\n',
          );
          await this.opts.onQr?.(qr);
        }

        if (usePairingCode && !pairingRequested && (connection === 'connecting' || qr)) {
          pairingRequested = true;
          try {
            const code = await sock.requestPairingCode(pairingPhone!);
            process.stdout.write(
              '\nקוד צימוד: ' + code + '\n' +
              'בטלפון: וואטסאפ > הגדרות > מכשירים מקושרים > קישור מכשיר > קישור באמצעות מספר טלפון\n\n',
            );
            await this.opts.onPairingCode?.(code);
          } catch (err) {
            pairingRequested = false;
            logger.error({ err: errorName(err) }, 'בקשת קוד הצימוד נכשלה');
          }
        }

        if (connection === 'open') {
          this.connected = true;
          this.reconnectAttempt = 0;
          logger.info('החיבור לוואטסאפ פתוח');
          try {
            await this.opts.onOpen?.();
          } catch (err) {
            logger.error({ err: errorName(err) }, 'שגיאה בטיפול בפתיחת החיבור');
          }
        }

        if (connection === 'close') {
          this.connected = false;
          if (this.stopped) return;
          const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
            ?.statusCode;
          await this.handleClose(statusCode);
        }
      })();
    });
  }

  private async handleClose(statusCode: number | undefined): Promise<void> {
    const { logger } = this.opts;

    if (statusCode === DisconnectReason.loggedOut) {
      logger.error(
        { statusCode },
        'המכשיר נותק מהחשבון (logged out). יש למחוק את תיקיית auth ולצמד מחדש, ראה README',
      );
      return this.fatal('logged_out');
    }
    if (statusCode === DisconnectReason.connectionReplaced) {
      logger.error({ statusCode }, 'החיבור הוחלף על ידי תהליך אחר שמשתמש באותה תיקיית auth. עוצר');
      return this.fatal('replaced');
    }
    if (statusCode === DisconnectReason.forbidden) {
      logger.error({ statusCode }, 'וואטסאפ דחה את החיבור (403). ייתכן שהחשבון נחסם. עוצר');
      return this.fatal('forbidden');
    }

    // אחרי סריקת QR וואטסאפ מנתק בכוונה ודורש חיבור מחדש מיידי (restartRequired)
    const immediate = statusCode === DisconnectReason.restartRequired;
    const delay = immediate ? 0 : Math.min(RECONNECT_MIN_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    if (!immediate) this.reconnectAttempt++;
    logger.warn({ statusCode, delayMs: delay, attempt: this.reconnectAttempt }, 'החיבור נסגר, מתחבר מחדש');
    if (!immediate) this.opts.onReconnecting?.(statusCode);

    if (delay > 0) {
      await sleep(delay, undefined, { signal: this.stopSignal.signal }).catch(() => undefined);
    }
    if (this.stopped) return;
    try {
      await this.connect();
    } catch (err) {
      logger.error({ err: errorName(err) }, 'התחברות מחדש נכשלה');
      await this.handleClose(undefined);
    }
  }

  private fatal(reason: FatalReason): void {
    this.stopped = true;
    this.sock = undefined;
    this.opts.onFatal?.(reason);
  }
}

/** שם השגיאה בלבד: הודעות שגיאה של הספרייה עלולות לכלול מזהי משתמשים. */
function errorName(err: unknown): string {
  if (err instanceof Error) {
    const status = (err as { output?: { statusCode?: number } }).output?.statusCode;
    return status ? `${err.name}(${status})` : err.name;
  }
  return 'UnknownError';
}
