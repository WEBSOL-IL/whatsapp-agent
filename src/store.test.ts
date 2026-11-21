import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { startOfDayMs, Store } from './store.js';

const G1 = '120363000000000001@g.us';
const G2 = '120363000000000002@g.us';

describe('Store', () => {
  it('קבוצה לא מוכרת כבויה, והיעד שלה פרטי', () => {
    const s = new Store(':memory:');
    assert.equal(s.isEnabled(G1), false);
    assert.equal(s.modeOf(G1), 'private');
    assert.equal(s.hasAnyGroup(), false);
  });

  it('הפעלה, כיבוי ויעד נשמרים, והפעלה לא מאפסת את היעד', () => {
    const s = new Store(':memory:');
    s.setMode(G1, 'משפחה', 'group');
    assert.equal(s.isEnabled(G1), false, 'קביעת יעד לא מפעילה את הקבוצה');
    s.setEnabled(G1, 'משפחה', true);
    assert.deepEqual(s.getGroup(G1), { jid: G1, name: 'משפחה', enabled: true, mode: 'group' });
    s.setEnabled(G1, 'משפחה', false);
    assert.equal(s.isEnabled(G1), false);
    assert.equal(s.modeOf(G1), 'group');
  });

  it('ההגדרות נשמרות אחרי סגירה ופתיחה מחדש של הקובץ', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'store-'));
    const file = path.join(dir, 'agent.db');
    try {
      const a = new Store(file);
      a.setEnabled(G1, 'עבודה', true);
      a.setMode(G1, 'עבודה', 'group');
      a.addProcessed('k1');
      a.paused = true;
      a.close();

      const b = new Store(file);
      assert.deepEqual(b.enabledGroups(), [{ jid: G1, name: 'עבודה', enabled: true, mode: 'group' }]);
      assert.equal(b.hasProcessed('k1'), true);
      assert.equal(b.paused, true);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('רענון שמות מעדכן קבוצה שמורה ולא מוסיף קבוצות חדשות', () => {
    const s = new Store(':memory:');
    s.setEnabled(G1, 'שם ישן', true);
    s.refreshNames([
      { jid: G1, name: 'שם חדש' },
      { jid: G2, name: 'קבוצה אחרת' },
    ]);
    assert.equal(s.getGroup(G1)?.name, 'שם חדש');
    assert.equal(s.getGroup(G2), undefined);
    assert.equal(s.countEnabled(), 1);
  });

  it('מזהי הודעות: רישום, בדיקה ומחיקת ישנים', () => {
    let now = 1_000_000_000_000;
    const s = new Store(':memory:', () => now);
    s.addProcessed('old');
    s.addProcessed('old'); // רישום כפול לא נכשל
    now += 8 * 24 * 60 * 60 * 1000;
    s.addProcessed('new');
    s.prune();
    assert.equal(s.hasProcessed('old'), false);
    assert.equal(s.hasProcessed('new'), true);
  });

  it('יומן: ספירת תמלולים ושניות מאז זמן נתון', () => {
    let now = 1_000_000_000_000;
    const s = new Store(':memory:', () => now);
    s.addJournal({ messageId: 'a', groupJid: G1, seconds: 30, status: 'transcribed' });
    now += 60_000;
    const since = now;
    s.addJournal({ messageId: 'b', groupJid: G1, seconds: 40, status: 'transcribed' });
    s.addJournal({ messageId: 'c', groupJid: G1, seconds: 700, status: 'skipped', detail: 'too_long' });
    s.addJournal({ messageId: 'd', groupJid: G1, seconds: 5, status: 'empty' });
    assert.equal(s.countSince('transcribed', since), 1);
    assert.equal(s.countSince('transcribed', 0), 2);
    assert.equal(s.transcribedSecondsSince(since), 45, 'הודעה שדולגה לא נספרת');
  });
});

describe('startOfDayMs', () => {
  it('חצות לפי אזור הזמן, לא לפי UTC', () => {
    const now = Date.UTC(2026, 10, 21, 22, 30, 15); // 00:30:15 בישראל (UTC+2), כבר ביום הבא
    assert.equal(startOfDayMs(now, 'Asia/Jerusalem'), Date.UTC(2026, 10, 21, 22, 0, 0));
    assert.equal(startOfDayMs(now, 'UTC'), Date.UTC(2026, 10, 21, 0, 0, 0));
  });
});
