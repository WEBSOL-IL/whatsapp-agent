import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isGroupJid } from './filter.js';

const TEMPLATE = `# קבוצות מאושרות לתמלול (שלבים 2-3. בשלב 4 הרשימה תנוהל בפקודות וואטסאפ).
# שורה לכל קבוצה: המזהה שלה מתוך data/groups.txt, למשל:
# 120363012345678901@g.us
# שורות שמתחילות ב-# הן הערות. שינוי בקובץ נכנס לתוקף מיד, בלי הפעלה מחדש.
`;

/** פונקציה טהורה: מפענחת את תוכן הקובץ לרשימת מזהי קבוצות תקינים. */
export function parseAllowlist(text: string): { groups: Set<string>; invalidLines: number } {
  const groups = new Set<string>();
  let invalidLines = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (isGroupJid(line) && !/\s/.test(line)) groups.add(line);
    else invalidLines++;
  }
  return { groups, invalidLines };
}

/**
 * רשימת הקבוצות המאושרות מקובץ טקסט. הקובץ נקרא מחדש כשהוא משתנה,
 * כך שאפשר לערוך אותו ממנהל הקבצים בלי להפעיל מחדש את השירות.
 */
export class FileAllowlist {
  private groups = new Set<string>();
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
