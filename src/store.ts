import { DatabaseSync, type StatementSync } from 'node:sqlite';

/** לאן נשלח התמלול של קבוצה. */
export type DeliveryMode = 'private' | 'group';

export interface GroupRow {
  jid: string;
  name: string;
  enabled: boolean;
  mode: DeliveryMode;
}

export type JournalStatus = 'transcribed' | 'empty' | 'failed' | 'send_failed' | 'skipped';

export interface JournalEntry {
  messageId: string;
  groupJid: string;
  seconds: number;
  status: JournalStatus;
  /** סיבת דילוג או שם שגיאה. לעולם לא תוכן הודעה. */
  detail?: string;
}

const PROCESSED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const JOURNAL_KEEP_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * האחסון הקבוע ב-SQLite: קבוצות מאושרות והגדרותיהן, מזהי הודעות שטופלו, ויומן מטא-דאטה.
 * אין כאן אודיו, אין טקסט של תמלולים ואין מספרי טלפון של שולחים.
 * קבוצה מזוהה לפי ה-JID שלה. השם נשמר לתצוגה בלבד ומתרענן.
 */
export class Store {
  private readonly db: DatabaseSync;
  private readonly stmt: Record<string, StatementSync>;

  constructor(file: string, private readonly now: () => number = Date.now) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS groups (
        jid        TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 0,
        mode       TEXT NOT NULL DEFAULT 'private',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed (
        key TEXT PRIMARY KEY,
        at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS journal (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        group_jid  TEXT NOT NULL,
        seconds    INTEGER NOT NULL,
        status     TEXT NOT NULL,
        detail     TEXT,
        at         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS journal_at ON journal (at);
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const p = (sql: string) => this.db.prepare(sql);
    this.stmt = {
      getGroup: p('SELECT jid, name, enabled, mode FROM groups WHERE jid = ?'),
      enabledGroups: p('SELECT jid, name, enabled, mode FROM groups WHERE enabled = 1 ORDER BY name'),
      countEnabled: p('SELECT COUNT(*) AS n FROM groups WHERE enabled = 1'),
      countGroups: p('SELECT COUNT(*) AS n FROM groups'),
      upsertEnabled: p(`INSERT INTO groups (jid, name, enabled, mode, updated_at) VALUES (?, ?, ?, 'private', ?)
                        ON CONFLICT(jid) DO UPDATE SET name = excluded.name, enabled = excluded.enabled, updated_at = excluded.updated_at`),
      upsertMode: p(`INSERT INTO groups (jid, name, enabled, mode, updated_at) VALUES (?, ?, 0, ?, ?)
                     ON CONFLICT(jid) DO UPDATE SET name = excluded.name, mode = excluded.mode, updated_at = excluded.updated_at`),
      rename: p('UPDATE groups SET name = ?, updated_at = ? WHERE jid = ? AND name <> ?'),
      hasProcessed: p('SELECT 1 AS x FROM processed WHERE key = ?'),
      addProcessed: p('INSERT OR IGNORE INTO processed (key, at) VALUES (?, ?)'),
      pruneProcessed: p('DELETE FROM processed WHERE at < ?'),
      addJournal: p('INSERT INTO journal (message_id, group_jid, seconds, status, detail, at) VALUES (?, ?, ?, ?, ?, ?)'),
      pruneJournal: p('DELETE FROM journal WHERE at < ?'),
      countSince: p('SELECT COUNT(*) AS n FROM journal WHERE status = ? AND at >= ?'),
      secondsSince: p(`SELECT COALESCE(SUM(seconds), 0) AS n FROM journal WHERE status IN ('transcribed', 'empty', 'send_failed') AND at >= ?`),
      getSetting: p('SELECT value FROM settings WHERE key = ?'),
      setSetting: p('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    };
    this.prune();
  }

  close(): void {
    this.db.close();
  }

  // --- קבוצות ---

  getGroup(jid: string): GroupRow | undefined {
    const row = this.stmt.getGroup!.get(jid) as RawGroup | undefined;
    return row && toGroup(row);
  }

  /** קבוצה שלא הופעלה במפורש כבויה: זו ברירת המחדל גם לקבוצה חדשה. */
  isEnabled(jid: string): boolean {
    return this.getGroup(jid)?.enabled ?? false;
  }

  /** קבוצה בלי הגדרה מקבלת את היעד הבטוח: פרטי. */
  modeOf(jid: string): DeliveryMode {
    return this.getGroup(jid)?.mode ?? 'private';
  }

  enabledGroups(): GroupRow[] {
    return (this.stmt.enabledGroups!.all() as unknown as RawGroup[]).map(toGroup);
  }

  countEnabled(): number {
    return count(this.stmt.countEnabled!.get());
  }

  hasAnyGroup(): boolean {
    return count(this.stmt.countGroups!.get()) > 0;
  }

  setEnabled(jid: string, name: string, enabled: boolean): void {
    this.stmt.upsertEnabled!.run(jid, name, enabled ? 1 : 0, this.now());
  }

  setMode(jid: string, name: string, mode: DeliveryMode): void {
    this.stmt.upsertMode!.run(jid, name, mode, this.now());
  }

  /** מרענן שמות של קבוצות שכבר שמורות. לא מוסיף קבוצות חדשות. */
  refreshNames(groups: ReadonlyArray<{ jid: string; name: string }>): void {
    this.db.exec('BEGIN');
    try {
      for (const g of groups) this.stmt.rename!.run(g.name, this.now(), g.jid, g.name);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // --- מזהי הודעות שטופלו ---

  hasProcessed(key: string): boolean {
    return this.stmt.hasProcessed!.get(key) !== undefined;
  }

  addProcessed(key: string): void {
    this.stmt.addProcessed!.run(key, this.now());
  }

  // --- יומן מטא-דאטה ---

  addJournal(entry: JournalEntry): void {
    this.stmt.addJournal!.run(
      entry.messageId,
      entry.groupJid,
      Math.round(entry.seconds),
      entry.status,
      entry.detail ?? null,
      this.now(),
    );
  }

  countSince(status: JournalStatus, sinceMs: number): number {
    return count(this.stmt.countSince!.get(status, sinceMs));
  }

  /** שניות אודיו שנשלחו למנוע התמלול מאז הזמן הנתון. */
  transcribedSecondsSince(sinceMs: number): number {
    return count(this.stmt.secondsSince!.get(sinceMs));
  }

  // --- הגדרות ---

  get paused(): boolean {
    return this.getSetting('paused') === '1';
  }

  set paused(value: boolean) {
    this.setSetting('paused', value ? '1' : '0');
  }

  getSetting(key: string): string | undefined {
    return (this.stmt.getSetting!.get(key) as { value: string } | undefined)?.value;
  }

  setSetting(key: string, value: string): void {
    this.stmt.setSetting!.run(key, value);
  }

  /** מוחק רשומות ישנות, כדי שהקובץ לא יגדל בלי סוף. */
  prune(): void {
    this.stmt.pruneProcessed!.run(this.now() - PROCESSED_KEEP_MS);
    this.stmt.pruneJournal!.run(this.now() - JOURNAL_KEEP_MS);
  }
}

interface RawGroup {
  jid: string;
  name: string;
  enabled: number;
  mode: string;
}

function toGroup(row: RawGroup): GroupRow {
  return { jid: row.jid, name: row.name, enabled: row.enabled === 1, mode: row.mode === 'group' ? 'group' : 'private' };
}

function count(row: unknown): number {
  return Number((row as { n: number | bigint } | undefined)?.n ?? 0);
}

/** תחילת היום הנוכחי (חצות) באזור הזמן הנתון, באלפיות שנייה. */
export function startOfDayMs(nowMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(nowMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const sinceMidnightMs = ((get('hour') % 24) * 3600 + get('minute') * 60 + get('second')) * 1000 + (nowMs % 1000);
  return nowMs - sinceMidnightMs;
}
