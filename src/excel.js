// The Excel workbook is the record of the stock: formatted sheets for people, hidden ID columns for restoring.
import ExcelJS from 'exceljs';
import { computeNeed, orderList, takenForNeed, resolveMaster, STATUS_LABEL, isTag, cmpText } from './logic.js';

const KIND = { in: 'Eingang', out: 'Entnahme', undo: 'Storno', adjust: 'Korrektur', merge: 'Zusammengeführt' };
const KIND_BACK = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k]));
const STATUS_BACK = Object.fromEntries(Object.entries(STATUS_LABEL).map(([k, v]) => [v, k]));

const C = {
  ink: 'FF17202A', head: 'FF1F2A36', headText: 'FFFFFFFF', accent: 'FFD9480F', zebra: 'FFF4F6F8', line: 'FFD9DEE4',
  red: 'FFFDE8E6', redText: 'FFB42318', amber: 'FFFFF4E0', green: 'FFE3F3EA', greenText: 'FF1D7A4F', grey: 'FF8A96A3',
};
const thin = { style: 'thin', color: { argb: C.line } };
const dt = (t) => (t ? new Date(t) : null);

function table(ws, cols, rows, { widths = {}, hidden = [] } = {}) {
  ws.columns = cols.map((key) => ({ header: key, key, width: widths[key] || Math.max(10, key.length + 2), hidden: hidden.includes(key) }));
  const head = ws.getRow(1);
  head.height = 22;
  head.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: C.headText }, name: 'Calibri', size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.head } };
    cell.alignment = { vertical: 'middle' };
  });
  rows.forEach((r, i) => {
    const row = ws.addRow(r);
    if (i % 2 === 1) row.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.zebra } }; });
    row.eachCell({ includeEmpty: true }, (c) => { c.border = { bottom: thin }; });
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: rows.length + 1, column: cols.length } };
  return ws;
}
const colLetter = (ws, key) => ws.getColumn(key).letter;

export async function buildWorkbook({ products, log, jobs, needs = [] }, now = Date.now()) {
  const byEan = Object.fromEntries(products.map((p) => [p.ean, p]));
  const pname = (ean) => resolveMaster(byEan, ean)?.name || '';
  const jobName = Object.fromEntries(jobs.map((j) => [j.id, j.name]));
  const live = products.filter((p) => !p.aliasOf);
  const openNeeds = needs.filter((n) => !n.closed);
  const jobsById = Object.fromEntries(jobs.map((j) => [j.id, j]));
  const order = orderList(openNeeds, byEan, jobsById);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Lager Scanner';
  wb.created = new Date(now);

  // ---- Übersicht ----
  const ov = wb.addWorksheet('Übersicht', { properties: { tabColor: { argb: C.accent } }, views: [{ showGridLines: false }] });
  ov.columns = [{ width: 34 }, { width: 16 }, { width: 16 }, { width: 50 }];
  ov.getCell('A1').value = 'Lagerbestand';
  ov.getCell('A1').font = { bold: true, size: 22, color: { argb: C.ink } };
  ov.getCell('A2').value = `Stand: ${new Date(now).toLocaleString('de-DE')}`;
  ov.getCell('A2').font = { color: { argb: C.grey } };
  const kpis = [
    ['Produkte', live.length],
    ['Stück im Lager', live.reduce((s, p) => s + Math.max(0, p.qty || 0), 0)],
    ['Produkte ohne Bestand', live.filter((p) => (p.qty || 0) <= 0).length],
    ['Produkte ohne Barcode (eigener Code)', live.filter((p) => isTag(p.ean)).length],
    ['Offene Bedarfslisten', openNeeds.length],
    ['Zu bestellen (Positionen)', order.length],
    ['Zu bestellen (Stück)', order.reduce((s, o) => s + o.qty, 0)],
    ['Buchungen gesamt', log.length],
  ];
  kpis.forEach(([k, v], i) => {
    const r = ov.getRow(4 + i);
    r.getCell(1).value = k; r.getCell(2).value = v;
    r.getCell(1).font = { color: { argb: C.ink } };
    r.getCell(2).font = { bold: true, size: 13 };
    r.getCell(2).alignment = { horizontal: 'right' };
    [1, 2].forEach((c) => { r.getCell(c).border = { bottom: thin }; });
  });
  let row = 4 + kpis.length + 2;
  ov.getCell(`A${row}`).value = 'Bestand nach Kategorie';
  ov.getCell(`A${row}`).font = { bold: true, size: 14, color: { argb: C.accent } };
  row++;
  ['Kategorie', 'Produkte', 'Stück'].forEach((h, i) => {
    const c = ov.getRow(row).getCell(i + 1);
    c.value = h; c.font = { bold: true, color: { argb: C.headText } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.head } };
  });
  const cats = [...new Set(live.map((p) => p.category || 'Ohne Kategorie'))].sort();
  for (const cat of cats) {
    row++;
    const items = live.filter((p) => (p.category || 'Ohne Kategorie') === cat);
    const r = ov.getRow(row);
    r.getCell(1).value = cat;
    r.getCell(2).value = items.length;
    r.getCell(3).value = items.reduce((s, p) => s + Math.max(0, p.qty || 0), 0);
    [1, 2, 3].forEach((c) => { r.getCell(c).border = { bottom: thin }; });
  }
  row += 2;
  ov.getCell(`A${row}`).value = 'Blätter';
  ov.getCell(`A${row}`).font = { bold: true, size: 14, color: { argb: C.accent } };
  [
    ['Bestand', 'Alle Produkte mit aktuellem Bestand, nach Kategorie sortiert.'],
    ['Bedarf', 'Bedarfslisten: was gebraucht wird, was da ist, was fehlt.'],
    ['Bestellliste', 'Was für offene Bedarfslisten bestellt werden muss.'],
    ['Buchungen', 'Jede Ein- und Entnahme mit Zeit. Stornos stehen als eigene Zeile.'],
    ['Aufträge', 'Was für welchen Auftrag entnommen wurde.'],
  ].forEach(([a, b]) => { row++; ov.getCell(`A${row}`).value = a; ov.getCell(`A${row}`).font = { bold: true }; ov.getCell(`B${row}`).value = b; });
  row += 2;
  ov.getCell(`A${row}`).value = 'Diese Datei kann in der App unter Einstellungen → Excel laden wieder eingelesen werden. Graue Spalten ganz rechts nicht ändern.';
  ov.getCell(`A${row}`).font = { italic: true, color: { argb: C.grey } };

  // ---- Bestand ----
  const stockCols = ['Code', 'Art', 'Kategorie', 'Hersteller', 'Serie', 'Produkt', 'Variante', 'Farbe', 'Artikelnr.', 'Bestand', 'Status', 'Gleiches Produkt wie', 'Weitere Codes', 'Hinweis', 'Beschreibung', 'Quelle', 'Etikett-Text', 'Angelegt', 'Geändert'];
  const sorted = products.slice().sort((a, b) => !!a.aliasOf - !!b.aliasOf
    || cmpText(a.category, b.category) || cmpText(a.maker, b.maker) || cmpText(a.series, b.series) || cmpText(a.name, b.name));
  const st = table(wb.addWorksheet('Bestand', { properties: { tabColor: { argb: 'FF1D7A4F' } } }), stockCols, sorted.map((p) => ({
    Code: p.ean, Art: isTag(p.ean) ? 'Eigener Code' : 'EAN', Kategorie: p.category || '', Hersteller: p.maker || '', Serie: p.series || '',
    Produkt: p.name || '', Variante: p.variant || '', Farbe: p.color || '', 'Artikelnr.': p.model || '',
    Bestand: p.aliasOf ? 0 : p.qty || 0, Status: p.aliasOf ? 'Zusammengeführt' : STATUS_LABEL[p.status] || p.status || '',
    'Gleiches Produkt wie': p.aliasOf || '', 'Weitere Codes': (p.aliases || []).join(', '), Hinweis: p.aiNote || '',
    Beschreibung: p.description || '', Quelle: p.source || '', 'Etikett-Text': String(p.ocrText || '').slice(0, 2000),
    Angelegt: dt(p.created), Geändert: dt(p.updated),
  })), {
    widths: { Code: 17, Art: 12, Kategorie: 18, Hersteller: 18, Serie: 16, Produkt: 42, Variante: 10, Farbe: 12, 'Artikelnr.': 16, Bestand: 9, Status: 18, 'Gleiches Produkt wie': 17, 'Weitere Codes': 20, Hinweis: 34, Beschreibung: 40, Quelle: 30, 'Etikett-Text': 30, Angelegt: 17, Geändert: 17 },
  });
  st.getColumn('Code').numFmt = '@';
  st.getColumn('Bestand').font = { bold: true };
  st.getColumn('Bestand').alignment = { horizontal: 'center' };
  ['Angelegt', 'Geändert'].forEach((k) => { st.getColumn(k).numFmt = 'dd.mm.yyyy hh:mm'; });
  sorted.forEach((p, i) => { if (p.aliasOf) st.getRow(i + 2).font = { color: { argb: C.grey } }; });
  if (sorted.length) {
    const L = colLetter(st, 'Bestand'), S = colLetter(st, 'Status'), last = sorted.length + 1;
    st.addConditionalFormatting({ ref: `${L}2:${L}${last}`, rules: [{ type: 'cellIs', operator: 'lessThan', formulae: [1], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: C.red } }, font: { color: { argb: C.redText }, bold: true } } }] });
    st.addConditionalFormatting({ ref: `${S}2:${S}${last}`, rules: [
      { type: 'containsText', operator: 'containsText', text: 'fehlen', style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: C.amber } } } },
      { type: 'containsText', operator: 'containsText', text: 'unlesbar', style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: C.amber } } } },
    ] });
  }

  // ---- Bedarf ----
  const needCols = ['Bedarfsliste', 'Status', 'Position', 'Code', 'Produkt im Lager', 'Benötigt', 'Entnommen', 'Im Lager', 'Fehlt', 'Bedarf-ID', 'Zeilen-ID', 'Angelegt'];
  const needRows = [];
  for (const n of needs.slice().sort((a, b) => (a.closed - b.closed) || (b.created || 0) - (a.created || 0))) {
    for (const r of computeNeed(n.lines || [], byEan, takenForNeed(n.id, jobsById))) {
      needRows.push({ Bedarfsliste: n.name, Status: n.closed ? 'Erledigt' : 'Offen', Position: r.text, Code: r.product?.ean || '', 'Produkt im Lager': r.product?.name || '', Benötigt: r.qty, Entnommen: r.taken, 'Im Lager': r.fromStock, Fehlt: r.missing, 'Bedarf-ID': n.id, 'Zeilen-ID': r.id, Angelegt: dt(n.created) });
    }
    if (!(n.lines || []).length) needRows.push({ Bedarfsliste: n.name, Status: n.closed ? 'Erledigt' : 'Offen', Position: '', Code: '', 'Produkt im Lager': '', Benötigt: null, Entnommen: null, 'Im Lager': null, Fehlt: null, 'Bedarf-ID': n.id, 'Zeilen-ID': '', Angelegt: dt(n.created) });
  }
  const nd = table(wb.addWorksheet('Bedarf', { properties: { tabColor: { argb: 'FF9A5B00' } } }), needCols, needRows, {
    widths: { Bedarfsliste: 26, Status: 10, Position: 40, Code: 17, 'Produkt im Lager': 38, Benötigt: 10, Entnommen: 11, 'Im Lager': 10, Fehlt: 8, 'Bedarf-ID': 14, 'Zeilen-ID': 14, Angelegt: 17 },
    hidden: [],
  });
  needRows.forEach((r, i) => {
    if (r.Benötigt == null) return;
    const R = i + 2;
    nd.getCell(`${colLetter(nd, 'Fehlt')}${R}`).value = { formula: `MAX(0,${colLetter(nd, 'Benötigt')}${R}-${colLetter(nd, 'Entnommen')}${R}-${colLetter(nd, 'Im Lager')}${R})`, result: r.Fehlt };
  });
  ['Bedarf-ID', 'Zeilen-ID', 'Angelegt'].forEach((k) => { nd.getColumn(k).font = { color: { argb: C.grey } }; });
  nd.getColumn('Angelegt').numFmt = 'dd.mm.yyyy hh:mm';
  nd.getColumn('Code').numFmt = '@';
  ['Benötigt', 'Entnommen', 'Im Lager', 'Fehlt'].forEach((k) => { nd.getColumn(k).alignment = { horizontal: 'center' }; });
  if (needRows.length) {
    const F = colLetter(nd, 'Fehlt'), last = needRows.length + 1;
    nd.addConditionalFormatting({ ref: `${F}2:${F}${last}`, rules: [
      { type: 'cellIs', operator: 'greaterThan', formulae: [0], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: C.red } }, font: { color: { argb: C.redText }, bold: true } } },
      { type: 'cellIs', operator: 'equal', formulae: [0], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: C.green } }, font: { color: { argb: C.greenText } } } },
    ] });
  }

  // ---- Bestellliste ----
  const ordCols = ['Hersteller', 'Artikelnr.', 'Produkt', 'Code', 'Menge', 'Für Bedarfsliste'];
  const od = table(wb.addWorksheet('Bestellliste', { properties: { tabColor: { argb: 'FFB42318' } } }), ordCols, order.map((o) => ({
    Hersteller: o.maker, 'Artikelnr.': o.model, Produkt: o.name, Code: o.code, Menge: o.qty, 'Für Bedarfsliste': o.needs.join(', '),
  })), { widths: { Hersteller: 20, 'Artikelnr.': 18, Produkt: 46, Code: 17, Menge: 9, 'Für Bedarfsliste': 34 } });
  od.getColumn('Menge').font = { bold: true };
  od.getColumn('Menge').alignment = { horizontal: 'center' };
  od.getColumn('Code').numFmt = '@';
  if (order.length) {
    const r = od.addRow({ Produkt: 'Summe', Menge: { formula: `SUM(${colLetter(od, 'Menge')}2:${colLetter(od, 'Menge')}${order.length + 1})`, result: order.reduce((s, o) => s + o.qty, 0) } });
    r.font = { bold: true };
    r.eachCell({ includeEmpty: true }, (c) => { c.border = { top: { style: 'medium', color: { argb: C.ink } } }; });
  }

  // ---- Buchungen ----
  const logCols = ['Zeit', 'Art', 'Code', 'Produkt', 'Menge', 'Auftrag', 'Notiz', 'ID', 'Storno von', 'Storniert', 'Auftrag-ID', 'Korb', 'Zusammengeführt von'];
  const lg = table(wb.addWorksheet('Buchungen'), logCols, log.slice().sort((a, b) => a.t - b.t).map((e) => ({
    Zeit: dt(e.t), Art: KIND[e.k] || e.k, Code: e.e, Produkt: pname(e.e), Menge: e.q, Auftrag: e.j ? jobName[e.j] || '' : '',
    Notiz: e.note || '', ID: e.id, 'Storno von': e.r || '', Storniert: e.undone ? 'ja' : '', 'Auftrag-ID': e.j || '', Korb: e.b || '', 'Zusammengeführt von': e.from || '',
  })), { widths: { Zeit: 17, Art: 15, Code: 17, Produkt: 40, Menge: 8, Auftrag: 26, Notiz: 18, ID: 16, 'Storno von': 16, Storniert: 9, 'Auftrag-ID': 14, Korb: 14, 'Zusammengeführt von': 17 } });
  lg.getColumn('Zeit').numFmt = 'dd.mm.yyyy hh:mm:ss';
  lg.getColumn('Code').numFmt = '@';
  ['ID', 'Storno von', 'Storniert', 'Auftrag-ID', 'Korb', 'Zusammengeführt von'].forEach((k) => { lg.getColumn(k).font = { color: { argb: C.grey } }; });
  if (log.length) {
    const M = colLetter(lg, 'Menge'), last = log.length + 1;
    lg.addConditionalFormatting({ ref: `${M}2:${M}${last}`, rules: [
      { type: 'cellIs', operator: 'greaterThan', formulae: [0], style: { font: { color: { argb: C.greenText }, bold: true } } },
      { type: 'cellIs', operator: 'lessThan', formulae: [0], style: { font: { color: { argb: C.redText }, bold: true } } },
    ] });
  }

  // ---- Aufträge ----
  const jobCols = ['Auftrag', 'Status', 'Begonnen', 'Code', 'Produkt', 'Menge', 'Auftrag-ID', 'Bedarf-ID'];
  const jobRows = [];
  for (const j of jobs.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) {
    const items = Object.entries(j.items || {});
    const base = { Auftrag: j.name, Status: j.closed ? 'Abgeschlossen' : 'Offen', Begonnen: dt(j.createdAt), 'Auftrag-ID': j.id, 'Bedarf-ID': j.needId || '' };
    if (!items.length) jobRows.push({ ...base, Code: '', Produkt: '', Menge: null });
    for (const [ean, qty] of items) jobRows.push({ ...base, Code: ean, Produkt: pname(ean), Menge: qty });
  }
  const jb = table(wb.addWorksheet('Aufträge'), jobCols, jobRows, { widths: { Auftrag: 30, Status: 14, Begonnen: 17, Code: 17, Produkt: 40, Menge: 8, 'Auftrag-ID': 14, 'Bedarf-ID': 14 } });
  jb.getColumn('Begonnen').numFmt = 'dd.mm.yyyy';
  jb.getColumn('Code').numFmt = '@';
  ['Auftrag-ID', 'Bedarf-ID'].forEach((k) => { jb.getColumn(k).font = { color: { argb: C.grey } }; });

  return wb;
}

export async function workbookBytes(wb) {
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

// ---------- read back ----------
function sheetRows(wb, name) {
  const ws = wb.getWorksheet(name);
  if (!ws) throw new Error(`In der Datei fehlt das Blatt „${name}“. Bitte eine aus dieser App gespeicherte Excel-Datei nehmen.`);
  const head = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { head[i] = String(c.value ?? '').trim(); });
  const out = [];
  ws.eachRow({ includeEmpty: false }, (r, n) => {
    if (n === 1) return;
    const o = {};
    head.forEach((h, i) => {
      if (!h) return;
      let v = r.getCell(i).value;
      if (v && typeof v === 'object' && !(v instanceof Date)) v = 'result' in v ? v.result : 'text' in v ? v.text : v.richText ? v.richText.map((t) => t.text).join('') : v;
      o[h] = v ?? '';
    });
    out.push(o);
  });
  return out;
}
const ts = (v) => (v instanceof Date ? v.getTime() : v ? Date.parse(v) || 0 : 0);
const str = (v) => String(v ?? '').trim();

export async function parseWorkbook(buf) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf); } catch { throw new Error('Die Datei konnte nicht als Excel-Datei gelesen werden.'); }
  const products = sheetRows(wb, 'Bestand').filter((r) => str(r.Code)).map((r) => {
    const status = r.Status === 'Zusammengeführt' ? 'verified' : STATUS_BACK[r.Status] || 'edited';
    return {
      ean: str(r.Code), name: str(r.Produkt), maker: str(r.Hersteller), series: str(r.Serie), category: str(r.Kategorie),
      variant: str(r.Variante), color: str(r.Farbe), model: str(r['Artikelnr.']), description: str(r.Beschreibung), source: str(r.Quelle),
      qty: Number(r.Bestand) || 0, status: status === 'new' ? 'manual' : status,
      aliasOf: str(r['Gleiches Produkt wie']) || null,
      aliases: str(r['Weitere Codes']).split(',').map((s) => s.trim()).filter(Boolean),
      aiNote: str(r.Hinweis), ocrText: str(r['Etikett-Text']), hasImage: false,
      created: ts(r.Angelegt), updated: ts(r.Geändert),
    };
  });
  const log = sheetRows(wb, 'Buchungen').filter((r) => str(r.ID)).map((r) => {
    const e = { id: str(r.ID), t: ts(r.Zeit), k: KIND_BACK[r.Art] || str(r.Art), e: str(r.Code), q: Number(r.Menge) || 0 };
    if (str(r['Auftrag-ID'])) e.j = str(r['Auftrag-ID']);
    if (str(r['Storno von'])) e.r = str(r['Storno von']);
    if (str(r.Storniert) === 'ja') e.undone = true;
    if (str(r.Korb)) e.b = str(r.Korb);
    if (str(r['Zusammengeführt von'])) e.from = str(r['Zusammengeführt von']);
    if (str(r.Notiz)) e.note = str(r.Notiz);
    return e;
  });
  const jobs = {};
  for (const r of sheetRows(wb, 'Aufträge')) {
    const id = str(r['Auftrag-ID']);
    if (!id) continue;
    jobs[id] ||= { id, name: str(r.Auftrag) || id, closed: r.Status === 'Abgeschlossen', createdAt: ts(r.Begonnen), items: {}, ...(str(r['Bedarf-ID']) ? { needId: str(r['Bedarf-ID']) } : {}) };
    if (str(r.Code) && Number(r.Menge)) jobs[id].items[str(r.Code)] = Number(r.Menge);
  }
  const needs = {};
  for (const r of sheetRows(wb, 'Bedarf')) {
    const id = str(r['Bedarf-ID']);
    if (!id) continue;
    needs[id] ||= { id, name: str(r.Bedarfsliste) || 'Bedarf', closed: r.Status === 'Erledigt', created: ts(r.Angelegt), lines: [] };
    if (str(r['Zeilen-ID'])) needs[id].lines.push({ id: str(r['Zeilen-ID']), text: str(r.Position), qty: Number(r.Benötigt) || 1, code: str(r.Code) || null });
  }
  return { products, log, jobs: Object.values(jobs), needs: Object.values(needs) };
}
