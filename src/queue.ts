import PQueue from 'p-queue';

export interface QueueOptions {
  /** כמה משימות רצות במקביל. */
  concurrency: number;
  /** זמן מרבי לניסיון אחד. */
  timeoutMs: number;
  /** מספר הניסיונות הכולל למשימה, כולל הראשון. */
  maxAttempts: number;
  /** השהיה בין ניסיון שנכשל לבא אחריו. */
  retryDelayMs?: number;
}

export class TaskTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`task timed out after ${timeoutMs}ms`);
    this.name = 'TaskTimeoutError';
  }
}

/** השגיאה שנזרקת אחרי שכל הניסיונות נכשלו. */
export class TaskFailedError extends Error {
  constructor(
    readonly attempts: number,
    readonly lastError: unknown,
  ) {
    super(`task failed after ${attempts} attempts`);
    this.name = 'TaskFailedError';
  }
}

/**
 * תור התמלול: בזיכרון בלבד, מגביל מקביליות, קוצב זמן לכל ניסיון ומנסה שוב.
 * המשימה מקבלת AbortSignal וחייבת לכבד אותו, כדי שניסיון שפג זמנו באמת ייעצר.
 */
export class TranscriptionQueue {
  private readonly queue: PQueue;

  constructor(private readonly opts: QueueOptions) {
    this.queue = new PQueue({ concurrency: opts.concurrency });
  }

  get pending(): number {
    return this.queue.size + this.queue.pending;
  }

  add<T>(task: (signal: AbortSignal, attempt: number) => Promise<T>): Promise<T> {
    return this.queue.add(() => this.runWithRetries(task)) as Promise<T>;
  }

  /** מחכה שכל המשימות שבתור יסתיימו (לכיבוי מסודר). */
  onIdle(): Promise<void> {
    return this.queue.onIdle();
  }

  private async runWithRetries<T>(task: (signal: AbortSignal, attempt: number) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
      try {
        return await this.runOnce(task, attempt);
      } catch (err) {
        lastError = err;
        if (attempt < this.opts.maxAttempts && this.opts.retryDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, this.opts.retryDelayMs));
        }
      }
    }
    throw new TaskFailedError(this.opts.maxAttempts, lastError);
  }

  private async runOnce<T>(task: (signal: AbortSignal, attempt: number) => Promise<T>, attempt: number): Promise<T> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new TaskTimeoutError(this.opts.timeoutMs);
        controller.abort(err);
        reject(err);
      }, this.opts.timeoutMs);
    });
    try {
      return await Promise.race([task(controller.signal, attempt), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
