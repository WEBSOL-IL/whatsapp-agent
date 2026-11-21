import { setTimeout as sleep } from 'node:timers/promises';
import type { WAMessage } from 'baileys';
import type { DeliveryMode } from './store.js';
import type { Logger } from './logger.js';
import { formatPrivate, type TranscriptReady } from './pipeline.js';

export const GROUP_PREFIX = 'תמלול אוטומטי:';

export interface DeliveryDeps {
  logger: Logger;
  /** מצב ניסוי: לא שולחים דבר, רק מעבירים ל-onDryRun את מה שהיה נשלח. */
  dryRun: boolean;
  timeZone: string;
  modeOf: (groupJid: string) => DeliveryMode;
  sendToSelf: (text: string) => Promise<void>;
  replyInGroup: (original: WAMessage, text: string) => Promise<void>;
  onDryRun: (description: string) => void;
  /** השהיה קצרה לפני שליחה, כדי לא להיראות כמו בוט שעונה מיידית. */
  delayMs?: () => number;
}

export interface Delivery {
  /** שולח תמלול ליעד שהוגדר לקבוצה. */
  deliverTranscript(t: TranscriptReady): Promise<void>;
  /** שולח לבעל החשבון הודעת מערכת (שגיאה, דילוג) בצ'אט עם עצמו. */
  notifyOwner(text: string): Promise<void>;
}

/** פורמט ההודעה במצב קבוצה: תגובה מצוטטת שמתחילה ב"תמלול אוטומטי:". */
export function formatGroup(t: Pick<TranscriptReady, 'text'>): string {
  return `${GROUP_PREFIX}\n${t.text}`;
}

const defaultDelay = () => 1_000 + Math.floor(Math.random() * 2_000);

/**
 * שכבת השליחה. זו הנקודה היחידה בקוד שממנה יוצאות הודעות לוואטסאפ,
 * ולכן גם הנקודה היחידה שבודקת את DRY_RUN.
 */
export function createDelivery(deps: DeliveryDeps): Delivery {
  const delay = deps.delayMs ?? defaultDelay;

  async function send(target: 'self' | 'group', text: string, original?: WAMessage): Promise<void> {
    if (deps.dryRun) {
      const header = target === 'self' ? "[ניסוי] היה נשלח לצ'אט עם עצמי:" : '[ניסוי] היה נשלח כתגובה בקבוצה:';
      deps.onDryRun(`${header}\n${text}`);
      return;
    }
    await sleep(delay());
    if (target === 'group') await deps.replyInGroup(original!, text);
    else await deps.sendToSelf(text);
  }

  return {
    async deliverTranscript(t) {
      const mode = deps.modeOf(t.facts.chatJid);
      if (mode === 'group') await send('group', formatGroup(t), t.message);
      else await send('self', formatPrivate(t, deps.timeZone));
      deps.logger.info(
        { messageId: t.facts.messageId, groupId: t.facts.chatJid, mode, dryRun: deps.dryRun },
        deps.dryRun ? 'תמלול הודפס (מצב ניסוי)' : 'תמלול נשלח',
      );
    },

    async notifyOwner(text) {
      await send('self', text);
    },
  };
}
