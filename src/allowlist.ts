import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isGroupJid } from './filter.js';

const TEMPLATE = `# קבוצות מאושרות לתמלול (שלבים 2-3. בשלב 4 הרשימה תנוהל בפקודות וואטסאפ).
# שורה לכל קבוצה: המזהה שלה מתוך data/groups.txt, ואחריו (לא חובה) יעד התמלול:
#   פרטי  = התמלול נשלח רק לצ'אט שלך עם עצמך (ברירת המחדל)
#   קבוצה = התמלול נשלח כתגובה להודעה הקולית, וכל חברי הקבוצה רואים אותו
# דוגמאות:
# 120363012345678901@g.us
# 120363012345678902@g.us קבוצה
# שורות שמתחילות ב-# הן הערות. שינוי בקובץ נכנס לתוקף מיד, בלי הפעלה מחדש.
`;

/** לאן נשלח התמלול של קבוצה. */
export type DeliveryMode = 'private' | 'group';

const MODE_WORDS: Record<string, DeliveryMode> = {
  פרטי: 'private',
  private: 'private',
  קבוצה: 'group',
  group: 'group',
};

/** פונקציה טהורה: מפענחת את תוכן הקובץ למזהי קבוצות תקינים ויעד התמלול של כל אחת. */
export function parseAllowlist(text: string): { groups: Map<string, DeliveryMode>; invalidLines: number } {
  const groups = new Map<string, DeliveryMode>();
  let invalidLines = 0;
  for (const raw of text.split(/\r?\n/)) {
    const parts = raw.replace(/#.*$/, '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    const [jid, modeWord] = parts as [string, string | undefined];
    const mode = modeWord === undefined ? 'private' : MODE_WORDS[modeWord.toLowerCase()];
    if (parts.length <= 2 && isGroupJid(jid) && mode) groups.set(jid, mode);
    else invalidLines++;
  }
  return { groups, invalidLines };
}

/**
 * רשימת הקבוצות המאושרות מקובץ טקסט. הקובץ נקרא מחדש כשהוא משתנה,
 * כך שאפשר לערוך אותו ממנהל הקבצים בלי להפעיל מחדש את השירות.
 */
export class FileAllowlist {
  private groups = new Map<string, DeliveryMode>();
  private loadedMtimeMs = -1;

  constructor(
    private readonly file: string,
    private readonly onReload?: (count: number, invalidLines: number) => void,
  ) {
    if (!existsSync(file)) writeFileSync(file, TEMPLATE, { mode: 0o600 });
    this.refresh();
  }

  get size(): number {
    this.refresh();
    return this.groups.size;
  }

  has(groupJid: string): boolean {
    this.refresh();
    return this.groups.has(groupJid);
  }

  /** יעד התמלול של קבוצה. קבוצה שאינה ברשימה מקבלת את ברירת המחדל הבטוחה: פרטי. */
  modeOf(groupJid: string): DeliveryMode {
    this.refresh();
    return this.groups.get(groupJid) ?? 'private';
  }

  private refresh(): void {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.file).mtimeMs;
    } catch {
      return; // הקובץ נמחק או לא נגיש: ממשיכים עם הרשימה האחרונה
    }
    if (mtimeMs === this.loadedMtimeMs) return;
    this.loadedMtimeMs = mtimeMs;
    const { groups, invalidLines } = parseAllowlist(readFileSync(this.file, 'utf8'));
    this.groups = groups;
    this.onReload?.(groups.size, invalidLines);
  }
}
