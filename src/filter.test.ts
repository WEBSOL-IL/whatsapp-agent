import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decide, extractFacts, type FilterContext, type IncomingMessage, type MessageFacts } from './filter.js';

const NOW_SEC = 1_800_000_000;
const ALLOWED = '120363000000000001@g.us';
const OTHER_GROUP = '120363000000000002@g.us';

function ctx(overrides: Partial<FilterContext> = {}): FilterContext {
  return {
    nowMs: NOW_SEC * 1000,
    maxAgeSec: 60,
    maxVoiceSec: 600,
    isGroupAllowed: (jid) => jid === ALLOWED,
    isProcessed: () => false,
    ...overrides,
  };
}

function voice(overrides: Partial<MessageFacts> = {}): MessageFacts {
  return {
    chatJid: ALLOWED,
    messageId: 'MSG1',
    fromMe: false,
    upsertType: 'notify',
    timestampSec: NOW_SEC - 2,
    audio: { isVoiceNote: true, seconds: 12, mimeType: 'audio/ogg; codecs=opus' },
    ...overrides,
  };
}

describe('decide', () => {
  it('קבוצה מאושרת: הודעה קולית טרייה מעובדת', () => {
    assert.deepEqual(decide(voice(), ctx()), { action: 'process', dedupKey: `${ALLOWED}|MSG1` });
  });

  it('הודעה קולית יוצאת (ממני) בקבוצה מאושרת מעובדת', () => {
    assert.equal(decide(voice({ fromMe: true }), ctx()).action, 'process');
  });

  it('קבוצה לא מאושרת: מדלגים', () => {
    assert.deepEqual(decide(voice({ chatJid: OTHER_GROUP }), ctx()), { action: 'skip', reason: 'group_not_allowed' });
  });

  it("צ'אט פרטי: מדלגים, גם אם המזהה ברשימה", () => {
    const pn = '972500000000@s.whatsapp.net';
    assert.deepEqual(decide(voice({ chatJid: pn }), ctx({ isGroupAllowed: () => true })), {
      action: 'skip',
      reason: 'not_group',
    });
    assert.deepEqual(decide(voice({ chatJid: '123456789@lid' }), ctx({ isGroupAllowed: () => true })), {
      action: 'skip',
      reason: 'not_group',
    });
  });

  it('אודיו שאינו הודעה קולית (קובץ שהועבר): מדלגים', () => {
    const file = voice({ audio: { isVoiceNote: false, seconds: 12, mimeType: 'audio/mpeg' } });
    assert.deepEqual(decide(file, ctx()), { action: 'skip', reason: 'not_voice_note' });
  });

  it('הודעה בלי אודיו (טקסט): מדלגים', () => {
    assert.deepEqual(decide(voice({ audio: undefined }), ctx()), { action: 'skip', reason: 'not_audio' });
  });

  it('הודעה ישנה: מדלגים', () => {
    assert.deepEqual(decide(voice({ timestampSec: NOW_SEC - 61 }), ctx()), { action: 'skip', reason: 'too_old' });
  });

  it('הודעה מסנכרון היסטוריה (לא notify): מדלגים גם אם החותמת טרייה', () => {
    assert.deepEqual(decide(voice({ upsertType: 'append' }), ctx()), { action: 'skip', reason: 'not_realtime' });
  });

  it('הודעה כפולה: מדלגים', () => {
    const seen = new Set([`${ALLOWED}|MSG1`]);
    assert.deepEqual(decide(voice(), ctx({ isProcessed: (k) => seen.has(k) })), { action: 'skip', reason: 'duplicate' });
    assert.equal(decide(voice({ messageId: 'MSG2' }), ctx({ isProcessed: (k) => seen.has(k) })).action, 'process');
  });

  it('הודעה ארוכה מהתקרה: מדלגים. בדיוק בתקרה: מעובדת', () => {
    const long = voice({ audio: { isVoiceNote: true, seconds: 601, mimeType: 'audio/ogg' } });
    assert.deepEqual(decide(long, ctx()), { action: 'skip', reason: 'too_long' });
    const exact = voice({ audio: { isVoiceNote: true, seconds: 600, mimeType: 'audio/ogg' } });
    assert.equal(decide(exact, ctx()).action, 'process');
  });

  it('סדר הכללים: קבוצה לא מאושרת נעצרת לפני בדיקת סוג ואורך', () => {
    const msg = voice({ chatJid: OTHER_GROUP, audio: { isVoiceNote: true, seconds: 9999, mimeType: 'audio/ogg' } });
    assert.deepEqual(decide(msg, ctx()), { action: 'skip', reason: 'group_not_allowed' });
  });

  it('בדיקת הכפילות לא נקראת להודעה שנפסלה קודם', () => {
    let called = false;
    const spy = ctx({
      isProcessed: () => {
        called = true;
        return false;
      },
    });
    decide(voice({ chatJid: OTHER_GROUP }), spy);
    assert.equal(called, false);
  });
});

describe('extractFacts', () => {
  const raw: IncomingMessage = {
    key: { remoteJid: ALLOWED, id: 'ABC', fromMe: false },
    messageTimestamp: NOW_SEC,
    message: { audioMessage: { ptt: true, seconds: 7, mimetype: 'audio/ogg; codecs=opus' } },
  };

  it('שולף הודעה קולית רגילה', () => {
    assert.deepEqual(extractFacts(raw, 'notify'), {
      chatJid: ALLOWED,
      messageId: 'ABC',
      fromMe: false,
      upsertType: 'notify',
      timestampSec: NOW_SEC,
      audio: { isVoiceNote: true, seconds: 7, mimeType: 'audio/ogg; codecs=opus' },
    });
  });

  it('פותח הודעה עטופה של קבוצה עם הודעות נעלמות', () => {
    const wrapped = { ...raw, message: { ephemeralMessage: { message: raw.message } } };
    assert.equal(extractFacts(wrapped, 'notify')?.audio?.isVoiceNote, true);
  });

  it('חותמת זמן מסוג Long', () => {
    const long = { ...raw, messageTimestamp: { toNumber: () => NOW_SEC } };
    assert.equal(extractFacts(long, 'notify')?.timestampSec, NOW_SEC);
  });

  it('אודיו בלי דגל ptt אינו הודעה קולית', () => {
    const file = { ...raw, message: { audioMessage: { seconds: 7 } } };
    assert.equal(extractFacts(file, 'notify')?.audio?.isVoiceNote, false);
  });

  it('הודעה בלי מזהים מחזירה undefined', () => {
    assert.equal(extractFacts({ key: { remoteJid: ALLOWED } }, 'notify'), undefined);
  });
});
