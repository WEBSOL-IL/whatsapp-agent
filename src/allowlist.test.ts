import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAllowlist } from './allowlist.js';

describe('parseAllowlist', () => {
  it('קורא מזהי קבוצות ומתעלם מהערות ומשורות ריקות', () => {
    const { groups, invalidLines } = parseAllowlist(
      '# הערה\n\n120363000000000001@g.us\r\n  972500000000-1500000000@g.us  # קבוצה ישנה\n',
    );
    assert.deepEqual([...groups.keys()], ['120363000000000001@g.us', '972500000000-1500000000@g.us']);
    assert.equal(invalidLines, 0);
  });

  it('יעד התמלול: ברירת המחדל פרטי, ואפשר לקבוע קבוצה או פרטי במפורש', () => {
    const { groups, invalidLines } = parseAllowlist('1@g.us\n2@g.us קבוצה\n3@g.us פרטי\n4@g.us GROUP\n');
    assert.deepEqual([...groups], [
      ['1@g.us', 'private'],
      ['2@g.us', 'group'],
      ['3@g.us', 'private'],
      ['4@g.us', 'group'],
    ]);
    assert.equal(invalidLines, 0);
  });

  it('מילת יעד לא מוכרת פוסלת את השורה, כדי שקבוצה לא תופעל ביעד שגוי', () => {
    const { groups, invalidLines } = parseAllowlist('1@g.us כולם\n2@g.us קבוצה נוסף\n');
    assert.equal(groups.size, 0);
    assert.equal(invalidLines, 2);
  });

  it("דוחה שורות שאינן מזהה קבוצה, כולל צ'אט פרטי ושם קבוצה", () => {
    const { groups, invalidLines } = parseAllowlist('972500000000@s.whatsapp.net\nהמשפחה שלי\n1. קבוצה@g.us\n');
    assert.equal(groups.size, 0);
    assert.equal(invalidLines, 3);
  });
});
