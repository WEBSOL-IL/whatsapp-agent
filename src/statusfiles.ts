import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import type { GroupInfo } from './whatsapp.js';

/**
 * קבצי מצב בתיקיית data/, למי שמנהל את השרת דרך פאנל בלי מסוף:
 * אפשר לפתוח אותם במנהל הקבצים במקום לקרוא את הלוג.
 * אין בהם תוכן הודעות ואין מספרי טלפון של אנשים.
 */
export class StatusFiles {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  private write(name: string, text: string): void {
    writeFileSync(this.file(name), text, { mode: 0o600 });
  }

  status(text: string): void {
    this.write('status.txt', `${new Date().toISOString()}\n${text}\n`);
  }

  async pairingQr(qr: string): Promise<void> {
    await QRCode.toFile(this.file('pairing-qr.png'), qr, { width: 480, margin: 2 });
    chmodSync(this.file('pairing-qr.png'), 0o600);
    this.status(
      'ממתין לצימוד. פתח את data/pairing-qr.png וסרוק מהטלפון:\n' +
        'וואטסאפ > הגדרות > מכשירים מקושרים > קישור מכשיר.\n' +
        'הקוד מתחלף כל כ-20 שניות. אם הסריקה נכשלת, פתח את הקובץ מחדש.',
    );
  }

  pairingCode(code: string): void {
    this.write('pairing-code.txt', code + '\n');
    this.status(
      'ממתין לצימוד. קוד הצימוד נמצא ב-data/pairing-code.txt. בטלפון:\n' +
        'וואטסאפ > הגדרות > מכשירים מקושרים > קישור מכשיר > קישור באמצעות מספר טלפון.\n' +
        'הקוד תקף כשתי דקות מהשעה שבראש הקובץ (שעון UTC). אחר כך נוצר קוד חדש באותו קובץ.',
    );
  }

  clearPairing(): void {
    rmSync(this.file('pairing-qr.png'), { force: true });
    rmSync(this.file('pairing-code.txt'), { force: true });
  }

  groups(groups: GroupInfo[]): void {
    const lines = groups.map((g, i) => `${String(i + 1).padStart(3)}. ${g.name}\n     ${g.jid}`);
    this.write('groups.txt', `קבוצות (${groups.length}), עודכן ${new Date().toISOString()}\n\n${lines.join('\n')}\n`);
  }
}
