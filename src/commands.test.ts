import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chunk, createCommandHandler, parseCommand, textOf } from './commands.js';
import { Store } from './store.js';

describe('parseCommand', () => {
  it('טקסט שאינו פקודה מחזיר undefined', () => {
    assert.equal(parseCommand('שלום'), undefined);
    assert.equal(parseCommand('הפעל 3'), undefined);
    assert.equal(parseCommand(''), undefined);
  });

  it('כל הפקודות שבאפיון', () => {
    assert.deepEqual(parseCommand('!קבוצות'), { name: 'groups', filter: '' });
    assert.deepEqual(parseCommand('!קבוצות  משפחה שלי'), { name: 'groups', filter: 'משפחה שלי' });
    assert.deepEqual(parseCommand('!הפעל 3'), { name: 'enable', index: 3 });
    assert.deepEqual(parseCommand(' !כבה 12 '), { name: 'disable', index: 12 });
    assert.deepEqual(parseCommand('!מצב 3 פרטי'), { name: 'mode', index: 3, mode: 'private' });
    assert.deepEqual(parseCommand('!מצב 3 קבוצה'), { name: 'mode', index: 3, mode: 'group' });
    assert.deepEqual(parseCommand('!סטטוס'), { name: 'status' });
    assert.deepEqual(parseCommand('!השהה'), { name: 'pause' });
    assert.deepEqual(parseCommand('!המשך'), { name: 'resume' });
    assert.deepEqual(parseCommand('! עזרה'), { name: 'help' });
  });

  it('פקודה שגויה מחזירה הסבר ולא מבצעת דבר', () => {
    for (const text of ['!הפעל', '!הפעל שלוש', '!הפעל 0', '!הפעל 3 4', '!הפעל -1', '!מצב 3', '!מצב 3 כולם', '!בלה']) {
      assert.equal(parseCommand(text)?.name, 'invalid', text);
    }
  });
});

const GROUPS = [
  { jid: '1@g.us', name: 'אבא ואמא' },
  { jid: '2@g.us', name: 'העבודה' },
  { jid: '3@g.us', name: 'ועד הבית' },
];

function setup(groups = GROUPS) {
  const store = new Store(':memory:');
  const state = { groups: [...groups], connected: true };
  const run = createCommandHandler({
    store,
    listGroups: async () => state.groups,
    isConnected: () => state.connected,
    dryRun: false,
    timeZone: 'Asia/Jerusalem',
  });
  const send = async (text: string) => run(parseCommand(text)!);
  return { store, state, send };
}

describe('command handler', () => {
  it('!קבוצות מחזירה רשימה ממוספרת עם סימון לפעילות, והפעילות ראשונות', async () => {
    const h = setup();
    h.store.setEnabled('3@g.us', 'ועד הבית', true);
    const [reply] = await h.send('!קבוצות');
    assert.equal(reply, 'קבוצות: 3, מהן 1 פעילות\n1. ✅ ועד הבית (פרטי)\n2. אבא ואמא\n3. העבודה');
  });

  it('הפעלה וכיבוי נכנסים לתוקף מיד, והתשובה כוללת את שם הקבוצה', async () => {
    const h = setup();
    await h.send('!קבוצות');
    assert.deepEqual(await h.send('!הפעל 2'), ['הופעל תמלול בקבוצה "העבודה" (יעד: פרטי)']);
    assert.equal(h.store.isEnabled('2@g.us'), true);
    assert.deepEqual(await h.send('!כבה 2'), ['כובה תמלול בקבוצה "העבודה"']);
    assert.equal(h.store.isEnabled('2@g.us'), false);
  });

  it('!מצב קובע את היעד בלי להפעיל את הקבוצה', async () => {
    const h = setup();
    await h.send('!קבוצות');
    const [reply] = await h.send('!מצב 1 קבוצה');
    assert.match(reply!, /"אבא ואמא".*כתגובה בקבוצה עצמה.*כבויה כרגע/);
    assert.equal(h.store.modeOf('1@g.us'), 'group');
    assert.equal(h.store.isEnabled('1@g.us'), false);
  });

  it('בלי !קבוצות קודם, או עם מספר מחוץ לרשימה, לא משתנה דבר', async () => {
    const h = setup();
    assert.deepEqual(await h.send('!הפעל 1'), ['אין רשימה פעילה. שלח קודם !קבוצות']);
    await h.send('!קבוצות');
    assert.deepEqual(await h.send('!הפעל 9'), ['אין קבוצה מספר 9 ברשימה האחרונה (יש 3)']);
    assert.equal(h.store.countEnabled(), 0);
  });

  it('המספור תקף עד הקריאה הבאה: קבוצה חדשה לא מזיזה מספרים קיימים', async () => {
    const h = setup();
    await h.send('!קבוצות');
    // הצטרפות לקבוצה חדשה שממוינת ראשונה. המספור הישן עדיין בתוקף.
    h.state.groups = [{ jid: '0@g.us', name: 'אאא חדשה' }, ...GROUPS];
    await h.send('!הפעל 1');
    assert.equal(h.store.isEnabled('1@g.us'), true);
    assert.equal(h.store.isEnabled('0@g.us'), false, 'קבוצה חדשה כבויה כברירת מחדל');
    // אחרי קריאה חדשה המספור מתעדכן: הפעילה ראשונה, ואז החדשה
    const [reply] = await h.send('!קבוצות');
    assert.match(reply!, /1\. ✅ אבא ואמא \(פרטי\)\n2\. אאא חדשה/);
  });

  it('!קבוצות עם טקסט מסננת לפי שם, והמספור מתייחס לרשימה המסוננת', async () => {
    const h = setup();
    const [reply] = await h.send('!קבוצות בית');
    assert.equal(reply, 'קבוצות שמכילות "בית": 1, מהן 0 פעילות\n1. ועד הבית');
    await h.send('!הפעל 1');
    assert.equal(h.store.isEnabled('3@g.us'), true);
    assert.deepEqual(await h.send('!קבוצות xyz'), ['לא נמצאו קבוצות שהשם שלהן מכיל "xyz"']);
  });

  it('שם קבוצה שהשתנה מתרענן, והזיהוי נשאר לפי המזהה', async () => {
    const h = setup();
    await h.send('!קבוצות');
    await h.send('!הפעל 2');
    h.state.groups = GROUPS.map((g) => (g.jid === '2@g.us' ? { ...g, name: 'העבודה החדשה' } : g));
    const [reply] = await h.send('!קבוצות');
    assert.match(reply!, /✅ העבודה החדשה/);
    assert.equal(h.store.getGroup('2@g.us')?.name, 'העבודה החדשה');
  });

  it('!השהה ו-!המשך לא משנים את הרשימה', async () => {
    const h = setup();
    await h.send('!קבוצות');
    await h.send('!הפעל 1');
    await h.send('!השהה');
    assert.equal(h.store.paused, true);
    assert.equal(h.store.isEnabled('1@g.us'), true);
    assert.deepEqual(await h.send('!המשך'), ['התמלול חודש. קבוצות פעילות: 1']);
    assert.equal(h.store.paused, false);
  });

  it('!סטטוס: חיבור, קבוצות פעילות ותמלולים היום', async () => {
    const h = setup();
    h.store.setEnabled('1@g.us', 'אבא ואמא', true);
    h.store.addJournal({ messageId: 'a', groupJid: '1@g.us', seconds: 90, status: 'transcribed' });
    h.state.connected = false;
    const [reply] = await h.send('!סטטוס');
    assert.equal(reply, 'חיבור: מנותק\nתמלול: פעיל\nקבוצות פעילות: 1\nתמלולים היום: 1\nדקות אודיו היום: 2');
  });

  it('אף תשובה לא מתחילה ב-"!", כדי שלא תתפרש כפקודה', async () => {
    const h = setup();
    for (const text of ['!קבוצות', '!הפעל 1', '!כבה 1', '!מצב 1 קבוצה', '!סטטוס', '!השהה', '!המשך', '!עזרה', '!בלה']) {
      for (const reply of await h.send(text)) assert.equal(parseCommand(reply), undefined, text);
    }
  });

  it('רשימה ארוכה מתפצלת לכמה הודעות בלי לאבד שורות', async () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ jid: `${i}@g.us`, name: `קבוצה מספר ${i} עם שם ארוך למדי` }));
    const h = setup(many);
    const replies = await h.send('!קבוצות');
    assert.ok(replies.length > 1);
    assert.ok(replies.every((r) => r.length <= 12_000));
    assert.equal(replies.join('\n').split('\n').length, 601);
  });
});

describe('chunk / textOf', () => {
  it('chunk שומר על הסדר ועל התקרה', () => {
    assert.deepEqual(chunk(['aaa', 'bbb', 'ccc'], 7), ['aaa\nbbb', 'ccc']);
    assert.deepEqual(chunk([], 10), []);
  });

  it('textOf שולף טקסט מהודעה רגילה, מורחבת ועטופה', () => {
    assert.equal(textOf({ message: { conversation: '!סטטוס' } }), '!סטטוס');
    assert.equal(textOf({ message: { extendedTextMessage: { text: '!קבוצות' } } }), '!קבוצות');
    assert.equal(textOf({ message: { ephemeralMessage: { message: { conversation: '!המשך' } } } }), '!המשך');
    assert.equal(textOf({ message: {} }), undefined);
  });
});
