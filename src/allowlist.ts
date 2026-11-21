import { existsSync, readFileSync, renameSync } from 'node:fs';
import { isGroupJid } from './filter.js';
import type { DeliveryMode, Store } from './store.js';

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
 * ייבוא חד-פעמי של קובץ הקבוצות משלבים 2-3 אל מסד הנתונים.
 * רץ רק כשהמסד עדיין ריק, ואז משנה את שם הקובץ כדי שיהיה ברור שהוא כבר לא בשימוש.
 */
export function importAllowlistFile(file: string, store: Store, nameOf: (jid: string) => string): number {
  if (!existsSync(file) || store.hasAnyGroup()) return 0;
  const { groups } = parseAllowlist(readFileSync(file, 'utf8'));
  for (const [jid, mode] of groups) {
    store.setMode(jid, nameOf(jid), mode);
    store.setEnabled(jid, nameOf(jid), true);
  }
  renameSync(file, file + '.imported');
  return groups.size;
}
