import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TaskFailedError, TaskTimeoutError, TranscriptionQueue } from './queue.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('TranscriptionQueue', () => {
  it('מחזיר את תוצאת המשימה', async () => {
    const q = new TranscriptionQueue({ concurrency: 2, timeoutMs: 1000, maxAttempts: 2 });
    assert.equal(await q.add(async () => 'ok'), 'ok');
  });

  it('לא חורג מהמקביליות שהוגדרה', async () => {
    const q = new TranscriptionQueue({ concurrency: 2, timeoutMs: 1000, maxAttempts: 1 });
    let running = 0;
    let peak = 0;
    const task = async () => {
      peak = Math.max(peak, ++running);
      await sleep(20);
      running--;
    };
    await Promise.all(Array.from({ length: 6 }, () => q.add(task)));
    assert.equal(peak, 2);
  });

  it('מנסה שוב אחרי כישלון ומצליח בניסיון השני', async () => {
    const q = new TranscriptionQueue({ concurrency: 1, timeoutMs: 1000, maxAttempts: 2 });
    const attempts: number[] = [];
    const result = await q.add(async (_signal, attempt) => {
      attempts.push(attempt);
      if (attempt === 1) throw new Error('boom');
      return 'second';
    });
    assert.equal(result, 'second');
    assert.deepEqual(attempts, [1, 2]);
  });

  it('אחרי שכל הניסיונות נכשלו זורק TaskFailedError', async () => {
    const q = new TranscriptionQueue({ concurrency: 1, timeoutMs: 1000, maxAttempts: 2 });
    let calls = 0;
    await assert.rejects(
      q.add(async () => {
        calls++;
        throw new Error('always');
      }),
      (err: unknown) => err instanceof TaskFailedError && err.attempts === 2 && (err.lastError as Error).message === 'always',
    );
    assert.equal(calls, 2);
  });

  it('ניסיון שחורג מהזמן מבוטל דרך ה-signal ונספר ככישלון', async () => {
    const q = new TranscriptionQueue({ concurrency: 1, timeoutMs: 30, maxAttempts: 2 });
    let aborted = 0;
    await assert.rejects(
      q.add(async (signal) => {
        signal.addEventListener('abort', () => aborted++);
        await sleep(200);
      }),
      (err: unknown) => err instanceof TaskFailedError && err.lastError instanceof TaskTimeoutError,
    );
    assert.equal(aborted, 2);
  });

  it('כישלון של משימה אחת לא עוצר את התור', async () => {
    const q = new TranscriptionQueue({ concurrency: 1, timeoutMs: 1000, maxAttempts: 1 });
    const failed = q.add(async () => {
      throw new Error('x');
    });
    const ok = q.add(async () => 'fine');
    await assert.rejects(failed);
    assert.equal(await ok, 'fine');
  });
});
