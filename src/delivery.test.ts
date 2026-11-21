import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WAMessage } from 'baileys';
import { pino } from 'pino';
import { createDelivery, formatGroup, type DeliveryDeps } from './delivery.js';
import type { TranscriptReady } from './pipeline.js';

const GROUP = '120363000000000001@g.us';
const original = { key: { remoteJid: GROUP, id: 'MSG1', fromMe: false } } as WAMessage;
const transcript = {
  facts: { chatJid: GROUP, messageId: 'MSG1', timestampSec: Date.UTC(2026, 10, 21, 17, 52) / 1000 },
  message: original,
  groupName: 'המשפחה',
  senderName: 'דנה',
  text: 'אני בדרך',
  language: 'he',
} as TranscriptReady;

function harness(overrides: Partial<DeliveryDeps>) {
  const sent: Array<{ to: 'self' | 'group'; text: string; quoted?: WAMessage }> = [];
  const dry: string[] = [];
  const delivery = createDelivery({
    logger: pino({ level: 'silent' }),
    dryRun: false,
    timeZone: 'Asia/Jerusalem',
    modeOf: () => 'private',
    sendToSelf: async (text) => void sent.push({ to: 'self', text }),
    replyInGroup: async (quoted, text) => void sent.push({ to: 'group', text, quoted }),
    onDryRun: (d) => void dry.push(d),
    delayMs: () => 0,
    ...overrides,
  });
  return { delivery, sent, dry };
}

describe('delivery', () => {
  it("מצב פרטי: הטקסט נשלח רק לצ'אט עם עצמי, עם שם הקבוצה, השולח והשעה", async () => {
    const h = harness({});
    await h.delivery.deliverTranscript(transcript);
    assert.deepEqual(h.sent, [{ to: 'self', text: '[המשפחה] דנה, 19:52\nאני בדרך' }]);
  });

  it('מצב קבוצה: תגובה מצוטטת להודעה הקולית שמתחילה ב"תמלול אוטומטי:"', async () => {
    const h = harness({ modeOf: () => 'group' });
    await h.delivery.deliverTranscript(transcript);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0]!.to, 'group');
    assert.equal(h.sent[0]!.quoted, original);
    assert.equal(h.sent[0]!.text, 'תמלול אוטומטי:\nאני בדרך');
  });

  it('DRY_RUN: שום דבר לא נשלח, ומה שהיה נשלח מועבר להדפסה', async () => {
    for (const mode of ['private', 'group'] as const) {
      const h = harness({ dryRun: true, modeOf: () => mode });
      await h.delivery.deliverTranscript(transcript);
      await h.delivery.notifyOwner('הודעת מערכת');
      assert.deepEqual(h.sent, []);
      assert.equal(h.dry.length, 2);
      assert.match(h.dry[0]!, /אני בדרך/);
      assert.match(h.dry[0]!, mode === 'group' ? /כתגובה בקבוצה/ : /לצ'אט עם עצמי/);
    }
  });

  it("הודעת מערכת לבעל החשבון נשלחת תמיד לצ'אט עם עצמי, גם כשהקבוצה במצב קבוצה", async () => {
    const h = harness({ modeOf: () => 'group' });
    await h.delivery.notifyOwner('התמלול נכשל');
    assert.deepEqual(h.sent, [{ to: 'self', text: 'התמלול נכשל' }]);
  });

  it('formatGroup', () => {
    assert.equal(formatGroup({ text: 'שלום' }), 'תמלול אוטומטי:\nשלום');
  });
});
