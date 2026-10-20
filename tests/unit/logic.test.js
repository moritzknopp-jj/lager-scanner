import { describe, it, expect } from 'vitest';
import { takenForNeed, gtinValid, normalizeCode, resolveMaster, RepeatGuard, basketAdd, basketSet, basketTotal, shortages, guessFromOcr, ocrUsable, shouldRunCheck, makeTagCode, isTag, parseNeedText, suggestProducts, computeNeed, orderList, groupByCategory, findIssues, codeProblem } from '../../src/logic.js';

// Text Tesseract actually read from the EVN SLK24018 box photo (noise included).
const EVN_OCR = `An 4% p—
* | ; i
SLK24018 To; 2 ;
i
LED Netzgerät 24V/DC = 0,1-18W = [P20 EM Z 0]
Pri. 220-240V/AC | 50/60Hz VE) 7 ;
[=] hE C € (5 =m oO} i Jost
EVN-Lichttechnik GmbH
Zum Lichtblick 1-12 © on
90610 Winkelhaid : pe
Germany Eg
www.evn-lichttechnik.com 4" 037293 393362 "> 3
SLK24018_VL.pdf | 191720 | 1 IT SATT ET | n`;

describe('barcodes', () => {
  it('validates EAN-13 check digits', () => {
    expect(gtinValid('4037293393362')).toBe(true);
    expect(gtinValid('4037293393363')).toBe(false);
    expect(gtinValid('96385074')).toBe(true); // EAN-8
  });
  it('normalizes UPC-A to EAN-13 and rejects typos', () => {
    expect(normalizeCode(' 4037293393362 ')).toEqual({ code: '4037293393362' });
    expect(normalizeCode('036000291452')).toEqual({ code: '0036000291452' });
    expect(normalizeCode('4037293393361').error).toMatch(/Prüfziffer/);
    expect(normalizeCode('').error).toBeTruthy();
    expect(normalizeCode('ABC-123')).toEqual({ code: 'ABC-123' });
  });
});

describe('merged products', () => {
  it('follows alias links to the master and survives loops', () => {
    const products = { a: { ean: 'a' }, b: { ean: 'b', aliasOf: 'a' }, c: { ean: 'c', aliasOf: 'b' }, x: { ean: 'x', aliasOf: 'y' }, y: { ean: 'y', aliasOf: 'x' } };
    expect(resolveMaster(products, 'c').ean).toBe('a');
    expect(resolveMaster(products, 'a').ean).toBe('a');
    expect(resolveMaster(products, 'nope')).toBeNull();
    expect(['x', 'y']).toContain(resolveMaster(products, 'x').ean);
  });
});

describe('repeat guard', () => {
  it('counts a barcode held in view only once', () => {
    const g = new RepeatGuard({ gapMs: 700 });
    const hits = [0, 100, 200, 300, 400, 500, 600, 700, 800].filter((t) => g.shouldCount('L', t, 'camera'));
    expect(hits).toEqual([0]);
  });
  it('counts again after the barcode left the view (24 lamps in a row)', () => {
    const g = new RepeatGuard({ gapMs: 700 });
    let count = 0;
    let t = 0;
    for (let lamp = 0; lamp < 24; lamp++) {
      for (let f = 0; f < 5; f++) { if (g.shouldCount('LAMP', t, 'camera')) count++; t += 100; } // in view 0.5 s
      t += 900; // next lamp takes ~1 s to bring in
    }
    expect(count).toBe(24);
  });
  it('ignores scanner key bounce but counts deliberate repeats', () => {
    const g = new RepeatGuard({ bounceMs: 350 });
    expect(g.shouldCount('A', 0, 'key')).toBe(true);
    expect(g.shouldCount('A', 100, 'key')).toBe(false);
    expect(g.shouldCount('A', 600, 'key')).toBe(true);
    expect(g.shouldCount('B', 650, 'key')).toBe(true);
  });
});

describe('basket', () => {
  it('adds, sets and totals lines', () => {
    let b = basketAdd([], 'a');
    b = basketAdd(b, 'a');
    b = basketAdd(b, 'b', 3);
    expect(basketTotal(b)).toBe(5);
    b = basketSet(b, 'a', 24);
    expect(b.find((l) => l.ean === 'a').qty).toBe(24);
    b = basketAdd(b, 'b', -3);
    expect(b.map((l) => l.ean)).toEqual(['a']);
    expect(basketSet(b, 'a', 0)).toEqual([]);
  });
  it('reports shortages against stock, via merged products', () => {
    const products = { lamp: { ean: 'lamp', qty: 20 }, lamp2: { ean: 'lamp2', aliasOf: 'lamp', qty: 0 }, psu: { ean: 'psu', qty: 5 } };
    expect(shortages([{ ean: 'lamp2', qty: 24 }, { ean: 'psu', qty: 5 }], products)).toEqual([{ ean: 'lamp2', want: 24, have: 20 }]);
  });
});

describe('label text', () => {
  it('guesses name, maker and model from real OCR output', () => {
    const g = guessFromOcr(EVN_OCR);
    expect(g.model).toBe('SLK24018');
    expect(g.maker).toBe('EVN-Lichttechnik GmbH');
    expect(g.name).toMatch(/LED Netzgerät/);
  });
  it('judges whether OCR text is usable', () => {
    expect(ocrUsable(EVN_OCR, 51)).toBe(true);
    expect(ocrUsable('| ; i', 60)).toBe(false);
    expect(ocrUsable(EVN_OCR, 12)).toBe(false);
  });
});

describe('when to call Haiku', () => {
  const mk = (n, status, extra = {}) => Object.fromEntries(Array.from({ length: n }, (_, i) => [status + i, { ean: status + i, status, ...extra }]));
  it('waits for a full batch', () => {
    expect(shouldRunCheck(mk(9, 'ocr'), 10).run).toBe(false);
    expect(shouldRunCheck(mk(10, 'ocr'), 10)).toMatchObject({ run: true, reason: 'batch' });
  });
  it('runs right away when a label could not be read', () => {
    expect(shouldRunCheck({ ...mk(2, 'ocr'), ...mk(1, 'error', { hasImage: true }) }, 10)).toMatchObject({ run: true, reason: 'error' });
    expect(shouldRunCheck(mk(1, 'error', { hasImage: false }), 10).run).toBe(false);
  });
  it('ignores merged products', () => {
    expect(shouldRunCheck(mk(10, 'ocr', { aliasOf: 'x' }), 10).run).toBe(false);
  });
});

// A small Busch-Jaeger stock like the one in the brief.
const BJ = {
  r1: { ean: 'r1', name: 'Rahmen 1-fach', maker: 'Busch-Jaeger', series: 'future linear', category: 'Rahmen', variant: '1-fach', color: 'studioweiß', qty: 12 },
  r2: { ean: 'r2', name: 'Rahmen 2-fach', maker: 'Busch-Jaeger', series: 'future linear', category: 'Rahmen', variant: '2-fach', color: 'studioweiß', qty: 8 },
  sd: { ean: 'sd', name: 'SCHUKO-Steckdose', maker: 'Busch-Jaeger', series: 'future linear', category: 'Steckdose', qty: 30 },
  sd2: { ean: 'sd2', name: 'SCHUKO-Steckdose', aliasOf: 'sd', qty: 0 },
  re: { ean: 'T-FINDER-40-52', name: 'Relais 2 Wechsler 24 V', maker: 'Finder', category: 'Relais', model: '40.52', qty: 5 },
};

describe('needs list', () => {
  it('reads quantities in the ways people write them', () => {
    expect(parseNeedText('20 Steckdosen')).toEqual({ qty: 20, text: 'Steckdosen' });
    expect(parseNeedText('8x Rahmen 2-fach')).toEqual({ qty: 8, text: 'Rahmen 2-fach' });
    expect(parseNeedText('12 Stk. Rahmen einfach')).toEqual({ qty: 12, text: 'Rahmen einfach' });
    expect(parseNeedText('Rahmen zweifach 4 Stück')).toEqual({ qty: 4, text: 'Rahmen zweifach' });
    expect(parseNeedText('Dimmer')).toEqual({ qty: 1, text: 'Dimmer' });
  });
  it('suggests the right stock product and respects 1-fach / 2-fach', () => {
    expect(suggestProducts('Doppelrahmen Busch Jäger', BJ)[0].code).toBe('r2');
    expect(suggestProducts('Rahmen einfach', BJ).map((s) => s.code)).toEqual(['r1']);
    expect(suggestProducts('Steckdosen', BJ)[0].code).toBe('sd');
    expect(suggestProducts('Finder Relais', BJ)[0].code).toBe('T-FINDER-40-52');
    expect(suggestProducts('Bewegungsmelder', BJ)).toEqual([]);
  });
  it('shares stock between lines and lists what is missing', () => {
    const lines = [
      { id: 'a', text: 'Steckdosen', qty: 20, code: 'sd' },
      { id: 'b', text: 'Steckdosen Küche', qty: 15, code: 'sd2' }, // merged code, same stock
      { id: 'c', text: 'Rahmen 2-fach', qty: 10, code: 'r2' },
      { id: 'd', text: 'Dimmer', qty: 3, code: null },
    ];
    expect(computeNeed(lines, BJ).map((r) => [r.id, r.have, r.missing])).toEqual([['a', 20, 0], ['b', 10, 5], ['c', 8, 2], ['d', 0, 3]]);
    const order = orderList([{ name: 'Halle 2', lines }, { name: 'Alt', closed: true, lines: [{ id: 'x', text: 'Dimmer', qty: 50, code: null }] }], BJ);
    expect(order.map((o) => [o.name, o.qty])).toEqual([['Rahmen 2-fach', 2], ['SCHUKO-Steckdose', 5], ['Dimmer', 3]]);
    expect(order[0].needs).toEqual(['Halle 2']);
  });
  it('counts items already taken out for the list before stock', () => {
    const jobs = { j1: { id: 'j1', needId: 'N', items: { r2: 8 } }, j2: { id: 'j2', items: { r2: 99 } } };
    const taken = takenForNeed('N', jobs);
    expect(taken).toEqual({ r2: 8 });
    const products = { ...BJ, r2: { ...BJ.r2, qty: 0 } }; // the 8 left the shelf
    const [r] = computeNeed([{ id: 'c', text: 'Rahmen 2-fach', qty: 10, code: 'r2' }], products, taken);
    expect([r.taken, r.fromStock, r.missing]).toEqual([8, 0, 2]);
    expect(orderList([{ id: 'N', name: 'Halle 2', lines: [{ id: 'c', text: 'Rahmen 2-fach', qty: 10, code: 'r2' }] }], products, jobs)[0].qty).toBe(2);
  });
});

describe('products without barcode', () => {
  it('makes readable, unique own codes', () => {
    expect(makeTagCode({ maker: 'Finder', model: '40.52.9.024' }, {})).toBe('T-FINDER-40-52-9-024');
    expect(makeTagCode({ name: 'Relais grau' }, { 'T-RELAIS-GRAU': {} })).toBe('T-RELAIS-GRAU-2');
    expect(makeTagCode({ maker: 'Gira', name: 'Wippe Kreuzschalter weiß' }, {})).toBe('T-GIRA-WIPPE-KREUZSCHALTER-W');
    expect(isTag('T-GIRA-X')).toBe(true);
    expect(isTag('4037293393362')).toBe(false);
    expect(normalizeCode('T-FINDER-40-52')).toEqual({ code: 'T-FINDER-40-52' });
  });
});

describe('stock view', () => {
  it('groups by category with totals', () => {
    const g = groupByCategory(Object.values(BJ).filter((p) => !p.aliasOf));
    expect(g.map((x) => [x.category, x.items.length, x.qty])).toEqual([['Rahmen', 2, 20], ['Relais', 1, 5], ['Steckdose', 1, 30]]);
  });
});

describe('correction checks', () => {
  it('flags web addresses and bad EANs as codes', () => {
    expect(codeProblem('https://produkte.evn-lichttechnik.com/x.html')).toMatch(/Webadresse/);
    expect(codeProblem('0099009101')).toMatch(/10 Ziffern/);
    expect(codeProblem('4011395128244')).toBe('');
  });

  it('suggests reversing manual corrections, but not ones confirmed as right', () => {
    const log = [
      { id: 'a', k: 'adjust', e: 'X', q: 4 },
      { id: 'b', k: 'adjust', e: 'X', q: 5, ok: true },
      { id: 'c', k: 'adjust', e: 'X', q: 1, undone: true },
    ];
    expect(findIssues({}, log).adjusts.map((e) => e.id)).toEqual(['a']);
  });
});
