import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildWorkbook, workbookBytes, parseWorkbook } from '../../src/excel.js';

const T = (s) => Date.parse(s);
const data = {
  products: [
    { ean: '4037293393362', name: 'LED-Netzteil 24 V DC 18 W IP20', maker: 'EVN Lichttechnik', series: '', category: 'Netzteil/Treiber', variant: '18 W', model: 'SLK24018', orderNo: 'EVN-SLK24018', ids: 'SLK24018, 191120', price: 12.49, qty: 6, status: 'verified', aliases: ['0012345678905'], aliasOf: null, source: 'https://evn.example', created: T('2026-10-20T07:00:00Z'), updated: T('2026-10-20T08:00:00Z') },
    { ean: '0012345678905', name: 'LED-Netzteil', qty: 0, status: 'verified', aliases: [], aliasOf: '4037293393362', created: 1, updated: 2 },
    { ean: 'T-FINDER-40-52', gtin: '8012823046533', name: 'Relais 2 Wechsler 24 V', maker: 'Finder', category: 'Relais', model: '40.52', qty: 0, status: 'verified', aliases: [], aliasOf: null, created: 1, updated: 2 },
    { ean: '96385074', name: '', qty: 3, status: 'manual', aliases: [], aliasOf: null, created: 1, updated: 2 },
  ],
  log: [
    { id: 'a1', t: T('2026-10-20T08:00:00Z'), k: 'in', e: '4037293393362', q: 30, b: 'B1' },
    { id: 'a2', t: T('2026-10-20T09:00:00Z'), k: 'out', e: '4037293393362', q: -24, j: 'J1', b: 'B2' },
    { id: 'a3', t: T('2026-10-20T09:05:00Z'), k: 'in', e: '96385074', q: 3, undone: true },
    { id: 'a4', t: T('2026-10-20T09:06:00Z'), k: 'undo', e: '96385074', q: -3, r: 'a3' },
  ],
  jobs: [
    { id: 'J1', name: 'Halle 2 Beleuchtung', closed: false, createdAt: T('2026-10-20T07:00:00Z'), items: { '4037293393362': 24 } },
    { id: 'J2', name: 'Leer', closed: true, createdAt: T('2026-10-19T07:00:00Z'), items: {} },
  ],
  needs: [
    { id: 'N1', name: 'Halle 2 Elektro', created: T('2026-10-20T06:00:00Z'), closed: false, lines: [
      { id: 'l1', text: 'LED-Netzteile', qty: 10, code: '4037293393362' },
      { id: 'l2', text: 'Relais', qty: 4, code: 'T-FINDER-40-52' },
      { id: 'l3', text: 'Dimmer', qty: 2, code: null },
    ] },
  ],
};

async function readBack(bytes) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes);
  return wb;
}
const rows = (ws) => {
  const head = ws.getRow(1).values;
  const out = [];
  ws.eachRow((r, n) => { if (n > 1) out.push(Object.fromEntries(head.map((h, i) => [h, r.getCell(i).value]).filter(([h]) => h))); });
  return out;
};

describe('Excel workbook', () => {
  it('has the formatted sheets in German', async () => {
    const wb = await readBack(await workbookBytes(await buildWorkbook(data, T('2026-10-20T10:00:00Z'))));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Übersicht', 'Bestand', 'Bedarf', 'Bestellliste', 'Buchungen', 'Aufträge']);
    const ov = wb.getWorksheet('Übersicht');
    expect(ov.getCell('A1').value).toBe('Lagerbestand');
    const st = wb.getWorksheet('Bestand');
    expect(st.getRow(1).getCell(1).fill.fgColor.argb).toBe('FF1F2A36'); // dark header
    expect(st.views[0].state).toBe('frozen');
    expect(st.autoFilter).toBeTruthy();
    const evn = rows(st).find((r) => r['Artikelnr.'] === 'SLK24018');
    expect(evn).toMatchObject({ Code: '4037293393362', Art: 'EAN', Kategorie: 'Netzteil/Treiber', Bestand: 6, Status: 'Recherchiert', 'Weitere Codes': '0012345678905' });
    expect(rows(st).find((r) => r.Code === 'T-FINDER-40-52').Art).toBe('Eigener Code');
  });

  it('puts every known number in, with price and value columns for later', async () => {
    const wb = await readBack(await workbookBytes(await buildWorkbook(data)));
    const evn = rows(wb.getWorksheet('Bestand')).find((r) => r['Artikelnr.'] === 'SLK24018');
    expect(evn['Bestellnr.']).toBe('EVN-SLK24018');
    expect(evn['EAN/GTIN']).toBe('4037293393362, 0012345678905');
    expect(evn['Alle Nummern']).toBe('4037293393362, SLK24018, EVN-SLK24018, 0012345678905, 191120');
    expect(evn.Einheit).toBe('Stück');
    expect(evn['Einzelpreis (€)']).toBe(12.49);
    expect(evn['Wert (€)'].formula).toMatch(/^IF\(O\d+="","",M\d+\*O\d+\)$/);
    expect(evn['Wert (€)'].result).toBe(74.94);
    const ov = wb.getWorksheet('Übersicht');
    let total = null;
    ov.eachRow((r) => { if (String(r.getCell(1).value).startsWith('Lagerwert')) total = r.getCell(2).value; });
    expect(total.formula).toBe('SUM(Bestand!$P:$P)');
    expect(total.result).toBe(74.94);
    const ord = rows(wb.getWorksheet('Bestellliste'));
    expect(ord[0]).toMatchObject({ 'Bestellnr.': 'EVN-SLK24018', 'EAN/GTIN': '4037293393362, 0012345678905', Einheit: 'Stück' });
  });

  it('shows the needs list with what is there and what is missing', async () => {
    const wb = await readBack(await workbookBytes(await buildWorkbook(data)));
    const nd = rows(wb.getWorksheet('Bedarf'));
    expect(nd.map((r) => [r.Position, r.Benötigt, r.Entnommen, r['Im Lager'], r.Fehlt.result ?? r.Fehlt])).toEqual([['LED-Netzteile', 10, 0, 6, 4], ['Relais', 4, 0, 0, 4], ['Dimmer', 2, 0, 0, 2]]);
    expect(nd[0].Fehlt.formula).toMatch(/^MAX\(0,/);
    const od = rows(wb.getWorksheet('Bestellliste'));
    expect(od.slice(0, 3).map((r) => [r.Produkt, r.Menge])).toEqual([['LED-Netzteil 24 V DC 18 W IP20', 4], ['Relais 2 Wechsler 24 V', 4], ['Dimmer', 2]]);
    expect(od[3].Produkt).toBe('Summe');
    const lg = rows(wb.getWorksheet('Buchungen'));
    expect(lg.map((r) => r.Art)).toEqual(['Eingang', 'Entnahme', 'Eingang', 'Storno']);
    expect(lg[1].Auftrag).toBe('Halle 2 Beleuchtung');
  });

  it('reads back everything it wrote', async () => {
    const back = await parseWorkbook(await workbookBytes(await buildWorkbook(data)));
    const evn = back.products.find((p) => p.ean === '4037293393362');
    expect(evn).toMatchObject({ qty: 6, model: 'SLK24018', orderNo: 'EVN-SLK24018', price: 12.49, unit: 'Stück', category: 'Netzteil/Treiber', aliases: ['0012345678905'], aliasOf: null, status: 'verified', source: 'https://evn.example' });
    expect(evn.ids).toContain('191120');
    expect(back.products.find((p) => p.ean === '0012345678905').aliasOf).toBe('4037293393362');
    expect(back.products.find((p) => p.ean === '96385074').status).toBe('manual');
    expect(back.log[1]).toMatchObject({ id: 'a2', k: 'out', q: -24, j: 'J1', t: data.log[1].t });
    expect(back.log[2].undone).toBe(true);
    expect(back.log[3]).toMatchObject({ k: 'undo', r: 'a3' });
    expect(back.jobs.find((j) => j.id === 'J1').items).toEqual({ '4037293393362': 24 });
    expect(back.needs[0]).toMatchObject({ id: 'N1', name: 'Halle 2 Elektro', closed: false });
    expect(back.needs[0].lines).toEqual([
      { id: 'l1', text: 'LED-Netzteile', qty: 10, code: '4037293393362' },
      { id: 'l2', text: 'Relais', qty: 4, code: 'T-FINDER-40-52' },
      { id: 'l3', text: 'Dimmer', qty: 2, code: null },
    ]);
  });

  it('takes edits made in Excel', async () => {
    const wb = await readBack(await workbookBytes(await buildWorkbook(data)));
    const st = wb.getWorksheet('Bestand');
    const head = st.getRow(1).values;
    st.eachRow((r, n) => { if (n > 1 && r.getCell(head.indexOf('Code')).value === '4037293393362') r.getCell(head.indexOf('Bestand')).value = 40; });
    const back = await parseWorkbook(new Uint8Array(await wb.xlsx.writeBuffer()));
    expect(back.products.find((p) => p.ean === '4037293393362').qty).toBe(40);
  });

  it('shows the researched EAN of a product kept under its own code, and reads it back', async () => {
    const bytes = await workbookBytes(await buildWorkbook(data));
    const wb = await readBack(bytes);
    expect(rows(wb.getWorksheet('Bestand')).find((r) => r.Code === 'T-FINDER-40-52')['EAN/GTIN']).toBe('8012823046533');
    const back = await parseWorkbook(bytes);
    expect(back.products.find((p) => p.ean === 'T-FINDER-40-52').gtin).toBe('8012823046533');
    expect(back.products.find((p) => p.ean === '4037293393362').gtin).toBe('');
  });

  it('refuses a file that is not from the app', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Tabelle1').addRow(['x']);
    await expect(parseWorkbook(new Uint8Array(await wb.xlsx.writeBuffer()))).rejects.toThrow(/Bestand/);
  });
});
