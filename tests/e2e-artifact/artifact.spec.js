// The claude.ai build, driven with a stand-in for claude.ai's runtime (storage, Claude, downloads).
import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { installFakeClaude } from './fake-claude.js';
import { FIX, EVN, ean13 } from '../e2e/helpers.js';

const ExcelJS = createRequire(import.meta.url)('exceljs');

// Opens the app with an empty (or given) claude.ai database. reply(kind, prompt, nImages, model) answers Claude.
async function openArtifact(page, { dbKey = 'k' + Math.random().toString(36).slice(2), reply = () => ({}) } = {}) {
  const calls = [];
  const files = {};
  await page.exposeFunction('__sampleReply', (prompt, nImages, model, tier) => {
    const kind = /You are the correction agent/.test(prompt) ? 'correct' : /identify products for the stock list[\s\S]*Each item was scanned/.test(prompt) ? 'research' : /from the attached photo/.test(prompt) ? 'identify' : /typed a product/.test(prompt) ? 'lookup' : /needs list/.test(prompt) ? 'match' : 'other';
    calls.push({ kind, prompt, nImages, model, tier });
    return reply(kind, prompt, nImages, model);
  });
  await page.exposeFunction('__savedFile', (name, b64) => { files[name] = Buffer.from(b64, 'base64'); });
  await page.addInitScript(installFakeClaude, { dbKey });
  await page.goto('/');
  await page.waitForFunction(() => window.__lager && window.__lager.state.ai);
  return { calls, files, dbKey };
}
const product = (page, code) => page.evaluate((c) => window.__lager.state.products[c], code);
async function typeCode(page, code) {
  await page.fill('#codeInput', code);
  await page.press('#codeInput', 'Enter');
  await page.waitForTimeout(400);
}
async function book(page) {
  await page.evaluate(() => { document.getElementById('scanMsg').innerHTML = ''; });
  await page.click('#basketBook');
  await expect(page.locator('#scanMsg .msg.ok')).toBeVisible();
}
const eansIn = (prompt) => (prompt.match(/for each of these EANs: ([\d, ]+)/)?.[1] || '').split(',').map((s) => s.trim()).filter(Boolean);

test('claude.ai-Version: keine Live-Kamera, kein API-Schlüssel, Claude über das Abo', async ({ page }) => {
  await openArtifact(page);
  await expect(page.locator('.camera')).toBeHidden();
  await expect(page.locator('#scanBtn')).toContainText('Produkt scannen');
  await expect(page.locator('#noCodeBtn')).toHaveCount(0); // one button only
  await page.click('#openSettings');
  await expect(page.locator('#set-key')).toHaveCount(0);
  await expect(page.locator('.sheet')).toContainText('läuft über dein Claude-Abo');
  await expect(page.locator('.sheet')).toContainText('verfügbar');
});

test('Barcode-Foto: Produkt wird angelegt, Claude Haiku erkennt es am Foto (Paket 1 = sofort)', async ({ page }) => {
  const { calls } = await openArtifact(page, {
    reply: (kind, prompt) => kind === 'research'
      ? { items: eansIn(prompt).map((e) => ({ ean: e, name: 'LED-Netzteil 24 V DC 0,1-18 W IP20', maker: 'EVN Lichttechnik', series: '', category: 'Netzteil/Treiber', variant: '18 W', color: '', model: 'SLK24018', description: 'Konstantspannungs-Netzteil.', confidence: 'high', note: '', ean_on_label: e })), duplicates: [] }
      : {},
  });
  await page.click('#openSettings');
  await page.selectOption('#set-batch', '1');
  await page.click('.sheet [data-act=save-settings]');
  await page.waitForFunction(() => window.__lager.state.meta.batchSize === 1);

  await page.setInputFiles('#scanInput', path.join(FIX, 'barcode.png'));
  await expect(page.locator('.sheet h2')).toHaveText('Wie viele hinzufügen?', { timeout: 15_000 });
  await page.fill('#qs-qty', '12');
  await page.click('#qs-ok');
  await expect(page.locator(`#q-${EVN}`)).toHaveValue('12');
  await expect.poll(async () => (await product(page, EVN))?.status, { timeout: 15_000 }).toBe('verified');
  expect(await product(page, EVN)).toMatchObject({ name: 'LED-Netzteil 24 V DC 0,1-18 W IP20', maker: 'EVN Lichttechnik', model: 'SLK24018', category: 'Netzteil/Treiber' });
  const c = calls.find((x) => x.kind === 'research');
  expect(c.model).toBe('claude-haiku-5-5');
  expect(c.nImages).toBe(1); // Claude reads the label photo itself
  expect(eansIn(c.prompt)).toEqual([EVN]);
  expect(c.prompt).toContain('Busch-Jaeger');
  await expect(page.locator(`.line[data-ean="${EVN}"]`)).toContainText('LED-Netzteil 24 V DC');
});

test('Produkt ohne Barcode: Claude erkennt es am Foto und findet es beim zweiten Mal wieder', async ({ page }) => {
  let n = 0;
  const { calls } = await openArtifact(page, {
    reply: (kind) => {
      if (kind !== 'identify') return {};
      n++;
      const base = { name: 'Koppelrelais 2 Wechsler 24 V DC', maker: 'Finder', series: '40', category: 'Relais', variant: '2 Wechsler', color: '', model: '40.52.9.024', description: '', read_text: 'FINDER 40.52 24VDC', barcode_digits: '' };
      return n === 1 ? { ...base, match_code: '', match_confidence: 'none', match_reason: '' } : { ...base, match_code: 'T-FINDER-40-52-9-024', match_confidence: 'high', match_reason: 'Gleiche Typnummer' };
    },
  });
  await page.setInputFiles('#scanInput', path.join(FIX, 'nobarcode.png'));
  await expect(page.locator('#nf-name')).toHaveValue('Koppelrelais 2 Wechsler 24 V DC');
  await page.fill('#nf-qty', '5');
  await page.click('.sheet [data-act=create-new]');
  const code = 'T-FINDER-40-52-9-024';
  await expect(page.locator(`#q-${code}`)).toHaveValue('5');
  await book(page);
  expect((await product(page, code)).qty).toBe(5);
  expect(calls[0]).toMatchObject({ kind: 'identify', nImages: 1, model: 'claude-haiku-5-5' });

  await page.setInputFiles('#scanInput', path.join(FIX, 'nobarcode.png'));
  await expect(page.locator('#id-result')).toContainText('Erkannt: Koppelrelais 2 Wechsler 24 V DC');
  await page.click('.sheet [data-act=use-match]');
  await page.fill('#qs-qty', '2');
  await page.click('#qs-ok');
  await expect(page.locator(`#q-${code}`)).toHaveValue('2');
  expect(calls[1].prompt).toContain(code);

  // QR label is saved as an image (no printing inside claude.ai).
  await page.click('#basketClear');
  await page.click('.tabs [data-view=stock]');
  await page.click(`#stockList [data-ean="${code}"]`);
  await expect(page.locator('.sheet [data-act=print-label]')).toHaveText('Etikett als Bild speichern');
});

test('Claude abgelehnt: verständliche Meldung, selbst anlegen geht weiter', async ({ page }) => {
  await openArtifact(page, { reply: () => ({ __error: 'not_granted' }) });
  await page.setInputFiles('#scanInput', path.join(FIX, 'nobarcode.png'));
  await expect(page.locator('#id-result')).toContainText('Claude-Zugriff wurde für diese App abgelehnt');
  await page.click('.sheet [data-act=manual-new]');
  await page.fill('#nf-name', 'Abzweigdose grau');
  await page.click('.sheet [data-act=create-new]');
  await expect(page.locator('#q-T-ABZWEIGDOSE-GRAU')).toHaveValue('1');
});

test('Bedarfsliste, Entnehmen und Excel in der claude.ai-Version', async ({ page }) => {
  const { files } = await openArtifact(page);
  const SD = ean13('401111111111'), R2 = ean13('401111111113');
  for (const c of [SD, R2]) await typeCode(page, c);
  await book(page);
  for (const [c, name, qty] of [[SD, 'SCHUKO-Steckdose Busch-Jaeger future linear', 30], [R2, 'Rahmen 2-fach Busch-Jaeger future linear', 8]]) {
    await page.click('.tabs [data-view=stock]');
    await page.click(`#stockList [data-ean="${c}"]`);
    await page.fill('#pf-name', name);
    await page.click('.sheet [data-act=save]');
    await page.click(`#stockList [data-ean="${c}"]`);
    await page.fill('#pf-qty', String(qty));
    await page.click('.sheet [data-act=adjust]');
  }
  await page.click('.tabs [data-view=needs]');
  await page.fill('#needName', 'Halle 2 Elektro');
  await page.click('#needForm button');
  for (const l of ['20 Steckdosen', '10 Doppelrahmen', '3 Dimmer']) { await page.fill('#needLine', l); await page.press('#needLine', 'Enter'); }
  const lines = page.locator('#needLines .line');
  await expect(lines).toHaveCount(3);
  await expect(lines.nth(1)).toContainText('8 im Lager · 2 fehlen');
  await expect(page.locator('#needOrder .item')).toHaveCount(2);
  await page.click('[data-act=need-take]');
  await expect(page.locator('#basketBook')).toHaveText('28 entnehmen für Halle 2 Elektro');
  await book(page);
  expect((await product(page, SD)).qty).toBe(10);

  await page.click('#openExcel');
  await page.click('.sheet [data-act=excel-save]');
  await expect.poll(() => Object.keys(files).length).toBe(1);
  const [name] = Object.keys(files);
  expect(name).toMatch(/^lager-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(files[name]);
  expect(wb.worksheets.map((w) => w.name)).toEqual(['Übersicht', 'Bestand', 'Bedarf', 'Bestellliste', 'Buchungen', 'Aufträge']);
  const ord = wb.getWorksheet('Bestellliste');
  const head = ord.getRow(1).values;
  const rows = [];
  ord.eachRow((r, i) => { if (i > 1) rows.push([r.values[head.indexOf('Produkt')], r.values[head.indexOf('Menge')]]); });
  expect(rows.slice(0, 2)).toEqual([['Dimmer', 3], ['Rahmen 2-fach Busch-Jaeger future linear', 2]]); // no maker: alphabetical
  const lg = wb.getWorksheet('Buchungen');
  expect(lg.rowCount).toBe(1 + 2 + 2 + 2); // 2 in, 2 count corrections, 2 out
});

test('Änderung von einem anderen Gerät erscheint sofort', async ({ page }) => {
  await openArtifact(page);
  await typeCode(page, EVN);
  await book(page);
  await page.click('.tabs [data-view=stock]');
  await expect(page.locator(`#stockList [data-ean="${EVN}"] .n`)).toHaveText('1');
  // The phone books 9 more and renames it: the PC sees it without reloading.
  await page.evaluate((code) => {
    const path = 'catalog/s' + code.slice(-2);
    const d = window.__fakeDb.get(path);
    d.products[code] = { ...d.products[code], name: 'LED-Netzteil vom Handy' };
    window.__fakeDb.remoteSet(path, d);
    const logId = window.__fakeDb.paths().find((x) => x.startsWith('log/'));
    const log = window.__fakeDb.get(logId);
    log.entries.phone1 = { id: 'phone1', t: Date.now(), k: 'in', e: code, q: 9 };
    window.__fakeDb.remoteSet(logId, log);
  }, EVN);
  await expect(page.locator(`#stockList [data-ean="${EVN}"] .n`)).toHaveText('10');
  await expect(page.locator('#stockList')).toContainText('LED-Netzteil vom Handy');
});

test('Daten liegen in claude.ai und sind nach Neuladen da', async ({ page, context }) => {
  const { dbKey } = await openArtifact(page);
  await typeCode(page, EVN);
  await typeCode(page, EVN);
  await book(page);
  const page2 = await context.newPage();
  await openArtifact(page2, { dbKey });
  expect((await product(page2, EVN)).qty).toBe(2);
  await page2.click('.tabs [data-view=log]');
  await expect(page2.locator('#logList .item')).toHaveCount(1);
});

test('Korb mit Produkt, das nie gespeichert wurde (alter Fehler): wird repariert und lässt sich einbuchen', async ({ page }) => {
  // The state left behind by the read-only bug: 3 in the basket, product missing.
  const dbKey = 'orphan' + Math.random().toString(36).slice(2);
  await page.addInitScript(([k, code]) => {
    if (!localStorage.getItem('fakedb:' + k)) localStorage.setItem('fakedb:' + k, JSON.stringify([['meta/session', { v: { mode: 'in', jobId: '', basket: [{ ean: code, qty: 3 }] } }]]));
  }, [dbKey, EVN]);
  await openArtifact(page, { dbKey });
  await expect(page.locator(`#q-${EVN}`)).toHaveValue('3');
  await expect.poll(async () => (await product(page, EVN))?.status).toBe('ocr');
  await book(page);
  await expect(page.locator('#scanMsg')).toContainText('Eingebucht: 3 Stück');
  expect((await product(page, EVN)).qty).toBe(3);
});

test('Produkt per Name: Busch-Jaeger Schuko-Steckdose mit EAN aus Claudes Wissen, Kabel in Metern', async ({ page }) => {
  const SCHUKO = ean13('401139507314');
  const { calls } = await openArtifact(page, {
    reply: (kind, prompt) => {
      if (kind !== 'lookup') return {};
      const empty = { match_code: '', match_confidence: 'none', match_reason: '', series: '', variant: '', color: '', description: '', read_text: '', barcode_digits: '' };
      if (/NYM/.test(prompt.match(/typed a product: "([^"]+)"/)?.[1] || "")) return { ...empty, name: 'Mantelleitung NYM-J 3x1,5 mm²', maker: '', category: 'Kabel/Leitung', model: 'NYM-J 3x1,5', order_number: '', all_ids: 'NYM-J 3x1,5', unit: 'm', ean: '' };
      return { ...empty, name: 'SCHUKO-Steckdose mit erhöhtem Berührungsschutz', maker: 'Busch-Jaeger', series: 'Busch-balance SI', category: 'Steckdose', color: 'alpinweiß', model: '20 EUC-914', order_number: '2CKA002011A3920', all_ids: '20 EUC-914, 2CKA002011A3920, ' + SCHUKO, unit: 'Stück', ean: SCHUKO };
    },
  });
  await page.fill('#codeInput', 'Busch-Jaeger Schuko-Steckdose balance SI');
  await page.press('#codeInput', 'Enter');
  await expect(page.locator('#nf-name')).toHaveValue('SCHUKO-Steckdose mit erhöhtem Berührungsschutz');
  await expect(page.locator('#nf-order')).toHaveValue('2CKA002011A3920');
  await expect(page.locator('.sheet')).toContainText(`EAN ${SCHUKO} erkannt`);
  await page.fill('#nf-qty', '20');
  await page.click('.sheet [data-act=create-new]');
  await expect(page.locator(`#q-${SCHUKO}`)).toHaveValue('20');
  const p = await product(page, SCHUKO);
  expect(p).toMatchObject({ maker: 'Busch-Jaeger', model: '20 EUC-914', orderNo: '2CKA002011A3920', unit: 'Stück' });
  expect(p.ids).toContain('2CKA002011A3920');
  expect(p.aiNote).toContain('nicht vom Etikett');
  const look = calls.find((c) => c.kind === 'lookup');
  expect(look.prompt).toContain('Busch-Jaeger first');
  expect(look.prompt).toContain('future linear');

  // Cable: counted in metres.
  await page.fill('#codeInput', 'NYM-J 3x1,5');
  await page.press('#codeInput', 'Enter');
  await expect(page.locator('#nf-unit')).toHaveValue('m');
  await page.fill('#nf-qty', '50');
  await page.click('.sheet [data-act=create-new]');
  const cable = Object.values(await page.evaluate(() => window.__lager.state.products)).find((x) => x.unit === 'm');
  expect(cable).toMatchObject({ name: 'Mantelleitung NYM-J 3x1,5 mm²', category: 'Kabel/Leitung' });
  await expect(page.locator(`#q-${cable.ean}`)).toHaveValue('50');
  await book(page);
  await page.click('.tabs [data-view=stock]');
  await expect(page.locator(`#stockList [data-ean="${cable.ean}"] .n`)).toHaveText('50 m');
});

test('Recherche übernimmt alle Nummern ins Produkt und in Excel', async ({ page }) => {
  const { files } = await openArtifact(page, {
    reply: (kind, prompt) => kind === 'research'
      ? { items: eansIn(prompt).map((e) => ({ ean: e, name: 'Rahmen 2-fach Busch-balance SI alpinweiß', maker: 'Busch-Jaeger', series: 'Busch-balance SI', category: 'Rahmen', variant: '2-fach', color: 'alpinweiß', model: '1722-914', order_number: '2CKA001725A1558', all_ids: `1722-914, 2CKA001725A1558, 2CKA001718Z2654, ${e}`, unit: 'Stück', description: '', confidence: 'high', note: '', ean_on_label: e })), duplicates: [] }
      : {},
  });
  await page.click('#openSettings');
  await page.selectOption('#set-batch', '1');
  await page.click('.sheet [data-act=save-settings]');
  await page.setInputFiles('#scanInput', path.join(FIX, 'barcode.png'));
  await page.fill('#qs-qty', '5');
  await page.click('#qs-ok');
  await expect.poll(async () => (await product(page, EVN))?.status, { timeout: 15_000 }).toBe('verified');
  const p = await product(page, EVN);
  expect(p).toMatchObject({ model: '1722-914', orderNo: '2CKA001725A1558', series: 'Busch-balance SI' });
  expect(p.ids).toContain('2CKA001718Z2654');
  await book(page);
  await page.click('#openExcel');
  await page.click('.sheet [data-act=excel-save]');
  await expect.poll(() => Object.keys(files).length).toBe(1);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Object.values(files)[0]);
  const st = wb.getWorksheet('Bestand');
  const head = st.getRow(1).values;
  const row = st.getRow(2).values;
  expect(row[head.indexOf('Bestellnr.')]).toBe('2CKA001725A1558');
  expect(row[head.indexOf('EAN/GTIN')]).toBe(EVN);
  expect(row[head.indexOf('Alle Nummern')]).toContain('2CKA001718Z2654');
  expect(row[head.indexOf('Bestand')]).toBe(5);
  expect(head).toContain('Einzelpreis (€)');
  expect(head).toContain('Wert (€)');
});

test('Verspätete Sync-Daten überschreiben keine Bestände mehr (Fehler vom 20.10.)', async ({ page, context }) => {
  const { dbKey } = await openArtifact(page);
  const A = ean13('401139500001'), B = ean13('401139500002');
  for (const c of [A, B]) await typeCode(page, c);
  await book(page);
  // From here on, every sync update arrives late and shows the state before the newest write.
  await page.evaluate(() => { window.__fakeStale = true; });
  await typeCode(page, A);
  await page.fill(`#q-${A}`, '4');
  await page.locator(`#q-${A}`).dispatchEvent('change');
  await book(page); // A: 1 + 4
  // Edit B's details right away (like Claude research finishing at the same moment).
  await page.click('.tabs [data-view=stock]');
  await page.click(`#stockList [data-ean="${B}"]`);
  await page.fill('#pf-name', 'Rahmen 3-fach Busch-balance SI');
  await page.click('.sheet [data-act=save]');
  await page.click(`#stockList [data-ean="${A}"]`);
  await page.fill('#pf-name', 'Rahmen 2-fach Busch-balance SI');
  await page.click('.sheet [data-act=save]');
  await page.waitForTimeout(1500); // let all late snapshots land
  expect((await product(page, A)).qty).toBe(5);
  expect((await product(page, B)).qty).toBe(1);
  // A fresh device reads the same numbers from storage.
  const page2 = await context.newPage();
  await openArtifact(page2, { dbKey });
  expect((await product(page2, A))).toMatchObject({ qty: 5, name: 'Rahmen 2-fach Busch-balance SI' });
  expect((await product(page2, B))).toMatchObject({ qty: 1, name: 'Rahmen 3-fach Busch-balance SI' });
});

test('Alte Daten: Bestand wird aus der Buchungshistorie berechnet, alte Liste wird umgestellt', async ({ page }) => {
  const dbKey = 'old' + Math.random().toString(36).slice(2);
  await page.addInitScript(([k, code]) => {
    if (localStorage.getItem('fakedb:' + k)) return;
    localStorage.setItem('fakedb:' + k, JSON.stringify([
      ['catalog/s' + code.slice(-2), { products: { [code]: { ean: code, name: 'Leitungsschutzschalter B16', qty: 0, status: 'verified', aliases: [], aliasOf: null } } }],
      ['log/2026-10-20_0', { day: '2026-10-20', part: 0, entries: [
        { id: 'a', t: 1, k: 'in', e: code, q: 4 },
        { id: 'b', t: 2, k: 'in', e: code, q: 4 },
        { id: 'c', t: 3, k: 'adjust', e: code, q: 1, undone: true },
        { id: 'd', t: 4, k: 'undo', e: code, q: -1, r: 'c' },
      ] }],
    ]));
  }, [dbKey, EVN]);
  await openArtifact(page, { dbKey });
  expect((await product(page, EVN)).qty).toBe(8);
  await expect.poll(() => page.evaluate(() => Array.isArray(window.__fakeDb.get('log/2026-10-20_0').entries))).toBe(false);
  await typeCode(page, EVN);
  await book(page);
  expect((await product(page, EVN)).qty).toBe(9);
  expect(Object.keys(await page.evaluate(() => window.__fakeDb.get('log/2026-10-20_0').entries)).length).toBe(5);
});

test('Korrektur-Agent: Doppelte zusammenführen, Webadresse durch EAN ersetzen, Angaben korrigieren, falsche Korrektur stornieren', async ({ page }) => {
  const dbKey = 'corr' + Math.random().toString(36).slice(2);
  const URL_CODE = 'https://produkte.evn-lichttechnik.com/product_sH23-15002.html';
  const EAN_ON_PHOTO = ean13('403729300964');
  await page.addInitScript(([k, urlCode]) => {
    if (localStorage.getItem('fakedb:' + k)) return;
    const prod = (ean, f) => ({ ean, status: 'verified', aliases: [], aliasOf: null, created: 1, updated: 1, ...f });
    localStorage.setItem('fakedb:' + k, JSON.stringify([
      ['catalog/s01', { products: {
        'T-ABB-S201-B16': prod('T-ABB-S201-B16', { name: 'Leitungsschutzschalter B 16 A, 1-polig, Typ S201', maker: 'ABB', model: 'S201-B16' }),
        'T-ABB-S201-B16-2': prod('T-ABB-S201-B16-2', { name: 'Leitungsschutzschalter B 16 A, 1-polig, Typ S201', maker: 'ABB', model: 'S201-B16' }),
        'T-UNBEKANNT-SCHUKO': prod('T-UNBEKANNT-SCHUKO', { name: 'SCHUKO-Steckdosen-Einsatz', maker: 'unbekannt', ocrText: 'BUSCH-JAEGER 20 EUC-914' }),
      } }],
      ['catalog/s02', { products: { [urlCode]: prod(urlCode, { name: 'LED-Einbauleuchte', maker: 'EVN Lichttechnik', model: 'PC650N91602', status: 'manual' }) } }],
      ['log/2026-10-20_0', { day: '2026-10-20', part: 0, entries: {
        a: { id: 'a', t: 1, k: 'in', e: 'T-ABB-S201-B16', q: 4 },
        b: { id: 'b', t: 2, k: 'in', e: 'T-ABB-S201-B16-2', q: 4 },
        c: { id: 'c', t: 3, k: 'in', e: urlCode, q: 3 },
        d: { id: 'd', t: 4, k: 'in', e: 'T-UNBEKANNT-SCHUKO', q: 2 },
        e: { id: 'e', t: 5, k: 'adjust', e: 'T-UNBEKANNT-SCHUKO', q: 5 },
      } }],
    ]));
  }, [dbKey, URL_CODE]);
  const { calls } = await openArtifact(page, {
    dbKey,
    reply: (kind, prompt) => (kind !== 'correct' ? {} : {
      fixes: [
        { code: 'T-UNBEKANNT-SCHUKO', name: 'SCHUKO-Steckdosen-Einsatz mit erhöhtem Berührungsschutz', maker: 'Busch-Jaeger', series: '', category: 'Steckdose', variant: '', color: '', model: '20 EUC-914', order_number: '2CKA002011A3920', all_ids: '20 EUC-914, 2CKA002011A3920', unit: 'Stück', ean_on_photo: '', confidence: 'high', reason: 'Typnummer 20 EUC-914 auf dem Etikett' },
        { code: URL_CODE, name: '', maker: '', series: '', category: '', variant: '', color: '', model: '', order_number: '', all_ids: '', unit: '', ean_on_photo: EAN_ON_PHOTO, confidence: 'high', reason: 'EAN auf dem Foto lesbar' },
      ],
      merges: [],
    }),
  });
  await page.click('#openReview');
  await expect(page.locator('#corrPanel')).toContainText('fallen gerade auf');
  await page.click('[data-act=corr-run]');
  await expect(page.locator('#corrList .corr.merge')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('#corrList .corr.fix')).toContainText('20 EUC-914');
  await expect(page.locator('#corrList .corr.recode')).toContainText(EAN_ON_PHOTO);
  await expect(page.locator('#corrList .corr.adjust')).toContainText('Bestandskorrektur +5');
  const c = calls.find((x) => x.kind === 'correct');
  expect(c.prompt).toContain('T-UNBEKANNT-SCHUKO');
  expect(c.prompt).toContain('Code ist eine Webadresse');

  await page.click('[data-act=corr-all]');
  await expect(page.locator('#corrList .corr.merge, #corrList .corr.fix, #corrList .corr.recode')).toHaveCount(0, { timeout: 15_000 });
  await page.click('[data-act=corr-adj-all]');
  await expect(page.locator('#corrList .corr')).toHaveCount(0);

  const P = await page.evaluate(() => window.__lager.state.products);
  expect(P['T-ABB-S201-B16-2'].aliasOf).toBe('T-ABB-S201-B16');
  expect(P['T-ABB-S201-B16'].qty).toBe(8);
  expect(P[URL_CODE].aliasOf).toBe(EAN_ON_PHOTO);
  expect(P[EAN_ON_PHOTO]).toMatchObject({ qty: 3, model: 'PC650N91602' });
  expect(P['T-UNBEKANNT-SCHUKO']).toMatchObject({ maker: 'Busch-Jaeger', model: '20 EUC-914', orderNo: '2CKA002011A3920', qty: 2, status: 'verified' });
  // A QR web address is no longer accepted as a product code.
  await page.click('.tabs [data-view=scan]');
});
