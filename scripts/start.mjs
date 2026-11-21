// נקודת הפעלה אחת שמתאימה לפאנל ניהול בלי גישת מסוף:
// מוודאת גרסת Node, מתקינה תלויות ובונה רק כשמשהו השתנה, ואז מפעילה את השירות.
// הקובץ בכוונה JavaScript פשוט בלי תלויות, כדי שירוץ גם לפני ההתקנה.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

// אותה תיקייה קבועה שהשירות עצמו משתמש בה (ראה resolveStateDir ב-src/config.ts)
const stateDir = process.env.STATE_DIR ? path.resolve(process.env.STATE_DIR) : path.join(os.homedir(), 'whatsapp-agent-data');
const dataDir = path.resolve(stateDir, process.env.DATA_DIR || 'data');

function writeStatus(text) {
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dataDir, 'status.txt'), new Date().toISOString() + '\n' + text + '\n', { mode: 0o600 });
  } catch {
    // אין מה לעשות אם אי אפשר לכתוב; ההודעה מודפסת גם למסוף
  }
}

function fail(message) {
  console.error(message);
  writeStatus('שגיאה בהפעלה: ' + message);
  // המתנה לפני יציאה, כדי שהפעלה מחדש אוטומטית של הפאנל לא תרוץ בלולאה מהירה
  setTimeout(() => process.exit(2), 30_000);
}

function hashFiles(files) {
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    hash.update(file + '\0');
    hash.update(readFileSync(file));
  }
  return hash.digest('hex');
}

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

function readIfExists(file) {
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
}

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    return fail(
      'נדרש Node.js בגרסה 22.13 ומעלה, אבל רץ כרגע ' + process.versions.node +
      '. יש לבחור Node 22 בהגדרות ה-worker process בפאנל.',
    );
  }

  const lockHash = hashFiles(['package-lock.json']);
  const lockStamp = path.join('node_modules', '.lock-hash');
  if (readIfExists(lockStamp) !== lockHash) {
    writeStatus('מתקין תלויות (npm ci), זה לוקח כדקה...');
    console.log('מתקין תלויות...');
    try {
      execSync('npm ci --include=dev --no-audit --no-fund', { stdio: 'inherit' });
    } catch {
      return fail('התקנת התלויות (npm ci) נכשלה. בדוק את הלוג של התהליך.');
    }
    writeFileSync(lockStamp, lockHash);
  }

  const srcHash = hashFiles([...listFiles('src'), 'tsconfig.json', 'package-lock.json']);
  const srcStamp = path.join('dist', '.src-hash');
  if (readIfExists(srcStamp) !== srcHash) {
    writeStatus('בונה את הקוד...');
    console.log('בונה את הקוד...');
    try {
      execSync(`"${process.execPath}" node_modules/typescript/bin/tsc -p tsconfig.json`, { stdio: 'inherit' });
    } catch {
      return fail('בניית הקוד נכשלה. בדוק את הלוג של התהליך.');
    }
    writeFileSync(srcStamp, srcHash);
  }

  await import(pathToFileURL(path.join(root, 'dist', 'index.js')).href);
}

main().catch((err) => fail('שגיאה לא צפויה בהפעלה: ' + (err && err.name ? err.name : 'UnknownError')));
