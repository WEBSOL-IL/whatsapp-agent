import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WAMessage } from 'baileys';
import { pino } from 'pino';
import {
  createPipeline,
  formatPrivate,
  hasSpeech,
  MemoryProcessedStore,
  type Outcome,
  type PipelineDeps,
  type TranscriptReady,
} from './pipeline.js';
import { TranscriptionQueue } from './queue.js';

const NOW_SEC = 1_800_000_000;
const ALLOWED = '120363000000000001@g.us';

function voiceMessage(overrides: { jid?: string; id?: string; ptt?: boolean; seconds?: number; ts?: number } = {}): WAMessage {
  return {
    key: { remoteJid: overrides.jid ?? ALLOWED, id: overrides.id ?? 'MSG1', fromMe: false },
    messageTimestamp: overrides.ts ?? NOW_SEC - 1,
    pushName: 'דנה',
    message: { audioMessage: { ptt: overrides.ptt ?? true, seconds: overrides.seconds ?? 5, mimetype: 'audio/ogg; codecs=opus' } },
  } as WAMessage;
}

function harness(transcribe: () => Promise<{ text: string; language: string; durationSec: number }>) {
  const downloads: string[] = [];
  const transcripts: TranscriptReady[] = [];
  const outcomes: Outcome[] = [];
  const queue = new TranscriptionQueue({ concurrency: 2, timeoutMs: 1000, maxAttempts: 2 });
  const deps: PipelineDeps = {
    logger: pino({ level: 'silent' }),
    queue,
    transcriber: { transcribe },
    languageHint: undefined,
    maxVoiceSec: 600,
    maxMessageAgeSec: 60,
    isGroupAllowed: (jid) => jid === ALLOWED,
    processed: new MemoryProcessedStore(),
    downloadAudio: async (msg) => {
      downloads.push(msg.key.id!);
      return Buffer.from('audio');
    },
    groupName: () => 'קבוצת ניסוי',
    onTranscript: (t) => void transcripts.push(t),
    onOutcome: (o) => void outcomes.push(o),
    now: () => NOW_SEC * 1000,
  };
  return { handle: createPipeline(deps), deps, queue, downloads, transcripts, outcomes };
}

const ok = async () => ({ text: 'שלום עולם', language: 'he', durationSec: 5 });
const settle = async (q: TranscriptionQueue) => {
  await q.onIdle();
  await new Promise((resolve) => setImmediate(resolve));
};

describe('pipeline', () => {
  it('קולית בקבוצה מאושרת מורדת, מתומללת ומועברת הלאה', async () => {
    const h = harness(ok);
    h.handle(voiceMessage(), 'notify');
    await settle(h.queue);
    assert.deepEqual(h.downloads, ['MSG1']);
    assert.equal(h.transcripts.length, 1);
    assert.equal(h.transcripts[0]!.text, 'שלום עולם');
    assert.equal(h.transcripts[0]!.senderName, 'דנה');
    assert.equal(h.outcomes[0]!.status, 'transcribed');
  });

  it("קולית בקבוצה אחרת או בצ'אט פרטי לא מורדת בכלל", async () => {
    const h = harness(ok);
    h.handle(voiceMessage({ jid: '120363000000000002@g.us' }), 'notify');
    h.handle(voiceMessage({ jid: '972500000000@s.whatsapp.net', id: 'MSG2' }), 'notify');
    h.handle(voiceMessage({ jid: '123@lid', id: 'MSG3' }), 'notify');
    await settle(h.queue);
    assert.deepEqual(h.downloads, []);
    assert.equal(h.transcripts.length, 0);
  });

  it('קובץ אודיו, הודעה ארוכה מדי והודעת היסטוריה לא מורדים', async () => {
    const h = harness(ok);
    h.handle(voiceMessage({ ptt: false }), 'notify');
    h.handle(voiceMessage({ id: 'LONG', seconds: 601 }), 'notify');
    h.handle(voiceMessage({ id: 'OLD', ts: NOW_SEC - 3600 }), 'notify');
    h.handle(voiceMessage({ id: 'HIST' }), 'append');
    await settle(h.queue);
    assert.deepEqual(h.downloads, []);
    assert.deepEqual(
      h.outcomes.map((o) => (o.status === 'skipped' ? o.reason : o.status)),
      ['too_long', 'too_old', 'not_realtime'],
    );
  });

  it('אותה הודעה שמגיעה פעמיים מתומללת פעם אחת', async () => {
    const h = harness(ok);
    h.handle(voiceMessage(), 'notify');
    h.handle(voiceMessage(), 'notify');
    await settle(h.queue);
    assert.deepEqual(h.downloads, ['MSG1']);
    assert.equal(h.transcripts.length, 1);
  });

  it('תמלול ריק או של סימני פיסוק בלבד לא מועבר הלאה', async () => {
    const h = harness(async () => ({ text: ' ... ', language: 'he', durationSec: 2 }));
    h.handle(voiceMessage(), 'notify');
    await settle(h.queue);
    assert.equal(h.transcripts.length, 0);
    assert.equal(h.outcomes[0]!.status, 'empty');
  });

  it('אחרי שני ניסיונות שנכשלו ההודעה מסומנת ככישלון', async () => {
    let calls = 0;
    const h = harness(async () => {
      calls++;
      throw Object.assign(new Error('secret text'), { name: 'TranscriptionApiError', status: 500 });
    });
    h.handle(voiceMessage(), 'notify');
    await settle(h.queue);
    assert.equal(calls, 2);
    assert.deepEqual(h.downloads, ['MSG1', 'MSG1']);
    assert.deepEqual(h.outcomes.map((o) => (o.status === 'failed' ? o.error : o.status)), ['TranscriptionApiError(500)']);
  });

  it('כישלון בשליחה לא גורם לתמלול חוזר ולא לשליחה כפולה', async () => {
    let transcribeCalls = 0;
    let sendCalls = 0;
    const h = harness(async () => {
      transcribeCalls++;
      return { text: 'שלום', language: 'he', durationSec: 1 };
    });
    const handle = createPipeline({
      ...h.deps,
      onTranscript: () => {
        sendCalls++;
        throw new Error('send failed');
      },
    });
    handle(voiceMessage(), 'notify');
    handle(voiceMessage(), 'notify');
    await settle(h.queue);
    assert.equal(transcribeCalls, 1);
    assert.equal(sendCalls, 1);
    // ההודעה הכפולה נרשמת כדילוג, והראשונה ככישלון שליחה
    assert.deepEqual(h.outcomes.map((o) => o.status), ['skipped', 'send_failed']);
  });
});

describe('formatPrivate / hasSpeech', () => {
  it('פורמט: [שם הקבוצה] שם השולח, שעה ובשורה הבאה התמלול', () => {
    const t = {
      facts: { timestampSec: Date.UTC(2026, 10, 21, 17, 52) / 1000 },
      groupName: 'המשפחה',
      senderName: 'דנה',
      text: 'אני בדרך',
    } as TranscriptReady;
    assert.equal(formatPrivate(t, 'Asia/Jerusalem'), '[המשפחה] דנה, 19:52\nאני בדרך');
  });

  it('hasSpeech', () => {
    assert.equal(hasSpeech('שלום'), true);
    assert.equal(hasSpeech('42'), true);
    assert.equal(hasSpeech(''), false);
    assert.equal(hasSpeech(' . ... !'), false);
  });
});
