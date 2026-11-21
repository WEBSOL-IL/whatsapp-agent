import type { DeliveryMode, Store } from './store.js';
import { startOfDayMs } from './store.js';

export type Command =
  | { name: 'groups'; filter: string }
  | { name: 'enable'; index: number }
  | { name: 'disable'; index: number }
  | { name: 'mode'; index: number; mode: DeliveryMode }
  | { name: 'status' }
  | { name: 'pause' }
  | { name: 'resume' }
  | { name: 'help' }
  | { name: 'invalid'; message: string };

const MODE_WORDS: Record<string, DeliveryMode> = { פרטי: 'private', קבוצה: 'group' };
const MODE_LABEL: Record<DeliveryMode, string> = { private: 'פרטי', group: 'קבוצה' };

export const HELP_TEXT = [
  'פקודות:',
  '!קבוצות - רשימה ממוספרת של כל הקבוצות',
  '!קבוצות טקסט - רק קבוצות שהשם שלהן מכיל את הטקסט',
  '!הפעל 3 - מפעיל תמלול בקבוצה מספר 3',
  '!כבה 3 - מכבה תמלול בקבוצה מספר 3',
  '!מצב 3 פרטי / !מצב 3 קבוצה - לאן נשלח התמלול',
  '!סטטוס - מצב החיבור, קבוצות פעילות ותמלולים היום',
  '!השהה / !המשך - עצירה וחידוש של כל התמלול',
  'המספרים מתייחסים לרשימה האחרונה שהתקבלה מ-!קבוצות.',
].join('\n');

/**
 * פונקציה טהורה: מפענחת טקסט לפקודה. מחזירה undefined לכל טקסט שאינו פקודה,
 * כלומר שלא מתחיל ב-"!", כדי שהודעות רגילות בצ'אט עם עצמי לא יקבלו תשובה.
 */
export function parseCommand(text: string): Command | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('!')) return undefined;
  const [word = '', ...args] = trimmed.slice(1).trim().split(/\s+/);

  const index = (): number | undefined => {
    const n = Number(args[0]);
    return args[0] !== undefined && /^\d+$/.test(args[0]) && n >= 1 ? n : undefined;
  };

  switch (word) {
    case 'קבוצות':
      return { name: 'groups', filter: args.join(' ') };
    case 'הפעל':
    case 'כבה': {
      const n = index();
      if (n === undefined || args.length !== 1) {
        return { name: 'invalid', message: `צריך מספר קבוצה, למשל: !${word} 3` };
      }
      return { name: word === 'הפעל' ? 'enable' : 'disable', index: n };
    }
    case 'מצב': {
      const n = index();
      const mode = args[1] === undefined ? undefined : MODE_WORDS[args[1]];
      if (n === undefined || !mode || args.length !== 2) {
        return { name: 'invalid', message: 'צריך מספר קבוצה ויעד, למשל: !מצב 3 פרטי או !מצב 3 קבוצה' };
      }
      return { name: 'mode', index: n, mode };
    }
    case 'סטטוס':
      return args.length === 0 ? { name: 'status' } : { name: 'invalid', message: 'הפקודה !סטטוס לא מקבלת פרמטרים' };
    case 'השהה':
      return args.length === 0 ? { name: 'pause' } : { name: 'invalid', message: 'הפקודה !השהה לא מקבלת פרמטרים' };
    case 'המשך':
      return args.length === 0 ? { name: 'resume' } : { name: 'invalid', message: 'הפקודה !המשך לא מקבלת פרמטרים' };
    case 'עזרה':
      return { name: 'help' };
    default:
      return { name: 'invalid', message: 'פקודה לא מוכרת. שלח !עזרה לרשימת הפקודות' };
  }
}

export interface CommandDeps {
  store: Store;
  /** כל הקבוצות שהחשבון חבר בהן כרגע. */
  listGroups: () => Promise<Array<{ jid: string; name: string }>>;
  isConnected: () => boolean;
  dryRun: boolean;
  timeZone: string;
  /** תקרת דקות יומית, או undefined אם אין תקרה. */
  dailyLimitMinutes?: number;
  now?: () => number;
}

/** אורך מרבי להודעת תשובה אחת. רשימה ארוכה מתפצלת לכמה הודעות. */
const MAX_REPLY_CHARS = 12_000;

/**
 * מבצע פקודות ניהול ומחזיר את הודעות התשובה (אחת או יותר).
 * התשובות לעולם לא מתחילות ב-"!", כדי שלא יתפרשו בעצמן כפקודה.
 */
export function createCommandHandler(deps: CommandDeps): (command: Command) => Promise<string[]> {
  const now = deps.now ?? Date.now;
  // המספור של הקריאה האחרונה ל-!קבוצות. תקף עד הקריאה הבאה, כדי שמספר לא
  // יצביע על קבוצה אחרת אחרי הצטרפות לקבוצה חדשה.
  let numbering: Array<{ jid: string; name: string }> = [];

  const pick = (index: number): { jid: string; name: string } | string => {
    if (numbering.length === 0) return 'אין רשימה פעילה. שלח קודם !קבוצות';
    return numbering[index - 1] ?? `אין קבוצה מספר ${index} ברשימה האחרונה (יש ${numbering.length})`;
  };

  return async (command) => {
    const { store } = deps;
    switch (command.name) {
      case 'invalid':
        return [command.message];

      case 'help':
        return [HELP_TEXT];

      case 'groups': {
        const all = await deps.listGroups();
        store.refreshNames(all);
        const needle = command.filter.toLowerCase();
        const matching = needle ? all.filter((g) => g.name.toLowerCase().includes(needle)) : all;
        // פעילות קודם, ואחריהן לפי שם
        const active = new Map(store.enabledGroups().map((g) => [g.jid, g]));
        numbering = [...matching.filter((g) => active.has(g.jid)), ...matching.filter((g) => !active.has(g.jid))];
        if (numbering.length === 0) {
          return [needle ? `לא נמצאו קבוצות שהשם שלהן מכיל "${command.filter}"` : 'לא נמצאו קבוצות'];
        }
        const lines = numbering.map((g, i) => {
          const row = active.get(g.jid);
          return row ? `${i + 1}. ✅ ${g.name} (${MODE_LABEL[row.mode]})` : `${i + 1}. ${g.name}`;
        });
        const activeCount = numbering.filter((g) => active.has(g.jid)).length;
        const header = needle
          ? `קבוצות שמכילות "${command.filter}": ${numbering.length}, מהן ${activeCount} פעילות`
          : `קבוצות: ${numbering.length}, מהן ${activeCount} פעילות`;
        return chunk([header, ...lines], MAX_REPLY_CHARS);
      }

      case 'enable':
      case 'disable': {
        const group = pick(command.index);
        if (typeof group === 'string') return [group];
        const enable = command.name === 'enable';
        store.setEnabled(group.jid, group.name, enable);
        const mode = MODE_LABEL[store.modeOf(group.jid)];
        return [enable ? `הופעל תמלול בקבוצה "${group.name}" (יעד: ${mode})` : `כובה תמלול בקבוצה "${group.name}"`];
      }

      case 'mode': {
        const group = pick(command.index);
        if (typeof group === 'string') return [group];
        store.setMode(group.jid, group.name, command.mode);
        const where = command.mode === 'group' ? 'כתגובה בקבוצה עצמה' : "לצ'אט שלך עם עצמך";
        const suffix = store.isEnabled(group.jid) ? '' : ' (הקבוצה כבויה כרגע)';
        return [`התמלול של "${group.name}" יישלח ${where}${suffix}`];
      }

      case 'pause':
        store.paused = true;
        return ['התמלול הושהה בכל הקבוצות. הרשימה לא השתנתה. לחידוש: !המשך'];

      case 'resume':
        store.paused = false;
        return [`התמלול חודש. קבוצות פעילות: ${store.countEnabled()}`];

      case 'status': {
        const dayStart = startOfDayMs(now(), deps.timeZone);
        const minutes = Math.round(store.transcribedSecondsSince(dayStart) / 60);
        const lines = [
          `חיבור: ${deps.isConnected() ? 'מחובר' : 'מנותק'}`,
          `תמלול: ${store.paused ? 'מושהה' : 'פעיל'}${deps.dryRun ? ' (מצב ניסוי, לא נשלח לוואטסאפ)' : ''}`,
          `קבוצות פעילות: ${store.countEnabled()}`,
          `תמלולים היום: ${store.countSince('transcribed', dayStart)}`,
          deps.dailyLimitMinutes === undefined
            ? `דקות אודיו היום: ${minutes}`
            : `דקות אודיו היום: ${minutes} מתוך ${deps.dailyLimitMinutes}`,
        ];
        const failed = store.countSince('failed', dayStart) + store.countSince('send_failed', dayStart);
        if (failed > 0) lines.push(`כישלונות היום: ${failed}`);
        return [lines.join('\n')];
      }
    }
  };
}

/** מפצל שורות להודעות שכל אחת מהן קצרה מהתקרה. */
export function chunk(lines: string[], maxChars: number): string[] {
  const messages: string[] = [];
  let current = '';
  for (const line of lines) {
    if (current && current.length + 1 + line.length > maxChars) {
      messages.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) messages.push(current);
  return messages;
}

/** הטקסט של הודעה, אם היא הודעת טקסט. */
export function textOf(msg: {
  message?: {
    conversation?: string | null;
    extendedTextMessage?: { text?: string | null } | null;
    ephemeralMessage?: { message?: unknown } | null;
  } | null;
}): string | undefined {
  const content = (msg.message?.ephemeralMessage?.message ?? msg.message) as
    | { conversation?: string | null; extendedTextMessage?: { text?: string | null } | null }
    | null
    | undefined;
  return content?.conversation || content?.extendedTextMessage?.text || undefined;
}
