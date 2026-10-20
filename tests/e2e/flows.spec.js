import { test, expect } from '@playwright/test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FIX, EVN, openApp, typeCode, photoOf, setKey, product, ean13, mockClaude, requestedEans, kindOf } from './helpers.js';

const ExcelJS = createRequire(import.meta.url)('exceljs'); // CJS package

const LAMP = ean13('400638133393');
const LAMP_B = ean13('590123412345'); // same lamp, other supplier's barcode

// Book the basket and wait until it is stored.
async function book(page) {
  await page.evaluate(() => { document.getElementById('scanMsg').innerHTML = ''; }); // drop an older success message
  await page.click('#basketBook');
  await expect(page.locator('#scanMsg .msg.ok')).toBeVisible();
}

// Rename and set stock through the product screen, like a user would.
async function editProduct(page, code, { name, qty, category } = {}) {
  const back = await page.evaluate(() => window.__lager.state.view);
  await page.click('.tabs [data-view=stock]');
  await page.click(`#stockList [data-ean="${code}"]`);
  if (name) await page.fill('#pf-name', name);
  if (category) await page.selectOption('#pf-cat', category);
  await page.click('.sheet [data-act=save]');
  await expect(page.locator('.sheet')).toHaveCount(0);
  if (qty !== undefined) {
    await page.click(`#stockList [data-ean="${code}"]`);
    await page.fill('#pf-qty', String(qty));
    await page.click('.sheet [data-act=adjust]');
    await expect(page.locator('.sheet')).toHaveCount(0);
  }
  await page.click(`.tabs [data-view=${back}]`);
}

test('einbuchen, dann 24 Lampen für einen Auftrag entnehmen und sehen, was übrig ist', async ({ page }) => {
  await openApp(page);
  for (let i = 0; i < 3; i++) await typeCode(page, LAMP);
  await expect(page.locator(`#q-${LAMP}`)).toHaveValue('3');
  await page.fill(`#q-${LAMP}`, '30');
  await page.locator(`#q-${LAMP}`).dispatchEvent('change');
  await expect(page.locator('#basketBook')).toHaveText('30 einbuchen');
  await book(page);
  await expect(page.locator('#scanMsg')).toContainText('Eingebucht: 30 Stück');
  expect((await product(page, LAMP)).qty).toBe(30);
  await editProduct(page, LAMP, { name: 'LED-Panel 60x60' });

  await page.click('.tabs [data-view=jobs]');
  await page.fill('#jobName', 'Halle 2 Beleuchtung');
  await page.click('#jobForm button');
  await expect(page.locator('#modeOut')).toHaveAttribute('aria-pressed', 'true');

  for (let i = 0; i < 4; i++) await typeCode(page, LAMP);
  await expect(page.locator(`.line[data-ean="${LAMP}"]`)).toContainText('30 im Lager → 26 übrig');
  await page.fill(`#q-${LAMP}`, '24');
  await page.locator(`#q-${LAMP}`).dispatchEvent('change');
  await expect(page.locator('#basketBook')).toHaveText('24 entnehmen für Halle 2 Beleuchtung');
  await book(page);
  await expect(page.locator('#scanMsg')).toContainText('Entnommen: 24 Stück für Halle 2 Beleuchtung');
  await expect(page.locator('#scanMsg')).toContainText('LED-Panel 60x60: 6 übrig');
  expect((await product(page, LAMP)).qty).toBe(6);

  // More than is left: warning before booking.
  await typeCode(page, LAMP);
  await page.fill(`#q-${LAMP}`, '10');
  await page.locator(`#q-${LAMP}`).dispatchEvent('change');
  await expect(page.locator(`.line[data-ean="${LAMP}"]`)).toContainText('Nur 6 im Lager');
  await page.click('#basketBook');
  await expect(page.locator('#basketWarn')).toContainText('reicht der Bestand nicht');
  expect((await product(page, LAMP)).qty).toBe(6);
  await page.click('#basketClear');

  // Storno from the history: stock and job go back.
  await page.click('.tabs [data-view=log]');
  await page.locator('#logList .item', { hasText: '−24' }).getByRole('button', { name: 'Stornieren' }).click();
  await expect.poll(async () => (await product(page, LAMP)).qty).toBe(30);
  const job = await page.evaluate(() => Object.values(window.__lager.state.jobs)[0]);
  expect(job.items[LAMP]).toBeUndefined();
  await expect(page.locator('#logList .item.undone')).toHaveCount(1);
});

test('Bedarfsliste: was ist da, was muss bestellt werden, Vorhandenes entnehmen', async ({ page }) => {
  await openApp(page);
  const SD = ean13('401111111111'), R1 = ean13('401111111112'), R2 = ean13('401111111113');
  for (const c of [SD, R1, R2]) await typeCode(page, c);
  await book(page);
  await editProduct(page, SD, { name: 'SCHUKO-Steckdose Busch-Jaeger future linear', category: 'Steckdose', qty: 30 });
  await editProduct(page, R1, { name: 'Rahmen 1-fach Busch-Jaeger future linear', category: 'Rahmen', qty: 12 });
  await editProduct(page, R2, { name: 'Rahmen 2-fach Busch-Jaeger future linear', category: 'Rahmen', qty: 8 });

  // Stock view groups by category.
  await page.click('.tabs [data-view=stock]');
  await expect(page.locator('#stockList .group').first()).toContainText('Rahmen');
  await expect(page.locator('#stockList .group').first()).toContainText('2 Produkte · 20 Stück');

  await page.click('.tabs [data-view=needs]');
  await page.fill('#needName', 'Halle 2 Elektro');
  await page.click('#needForm button');
  await expect(page.locator('#needTitle')).toHaveText('Halle 2 Elektro');
  for (const line of ['20 Steckdosen', '10 Doppelrahmen', '3 Dimmer']) {
    await page.fill('#needLine', line);
    await page.press('#needLine', 'Enter');
  }
  // Typing shows matching stock products to pick.
  await page.fill('#needLine', '6 Rahmen einfach');
  await expect(page.locator('#needSuggest button')).toHaveCount(1);
  await expect(page.locator('#needSuggest')).toContainText('Rahmen 1-fach');
  await page.click('#needSuggest button');

  const lines = page.locator('#needLines .line');
  await expect(lines).toHaveCount(4);
  await expect(lines.nth(0)).toContainText('20 im Lager · komplett');
  await expect(lines.nth(1)).toContainText('8 im Lager · 2 fehlen');
  await expect(lines.nth(2)).toContainText('Nicht im Lager · 3 bestellen');
  await expect(lines.nth(3)).toContainText('6 im Lager · komplett');
  await expect(page.locator('#needStats')).toContainText('5'); // 2 + 3 missing
  await expect(page.locator('#needOrder .item')).toHaveCount(2);
  await expect(page.locator('#needOrder')).toContainText('Rahmen 2-fach Busch-Jaeger future linear');
  await expect(page.locator('#needOrder')).toContainText('Dimmer');

  // Take out what is there: basket gets 20 + 8 + 6, linked job is created.
  await page.click('[data-act=need-take]');
  await expect(page.locator('#view-scan')).toBeVisible();
  await expect(page.locator(`#q-${SD}`)).toHaveValue('20');
  await expect(page.locator(`#q-${R2}`)).toHaveValue('8');
  await expect(page.locator(`#q-${R1}`)).toHaveValue('6');
  await expect(page.locator('#basketBook')).toHaveText('34 entnehmen für Halle 2 Elektro');
  await book(page);
  expect((await product(page, SD)).qty).toBe(10);
  expect((await product(page, R2)).qty).toBe(0);

  // The list now counts what was taken; still only 2 frames and 3 dimmers to order.
  await page.click('.tabs [data-view=needs]');
  await expect(lines.nth(0)).toContainText('20 entnommen');
  await expect(lines.nth(1)).toContainText('8 entnommen · 0 im Lager · 2 fehlen');
  await expect(page.locator('[data-act=need-take]')).toHaveCount(0);
  await page.click('#needBack');
  await expect(page.locator('#needsItems')).toContainText('5 fehlen');
  await expect(page.locator('#orderAll .item')).toHaveCount(2);
});

test('Produkt ohne Barcode: Claude erkennt es, legt es mit eigenem Code an und findet es wieder', async ({ page }) => {
  let identifyCalls = 0;
  const calls = await mockClaude(page, (body) => {
    if (kindOf(body) !== 'identify') return { matches: [] };
    identifyCalls++;
    const base = { name: 'Koppelrelais 2 Wechsler 24 V DC', maker: 'Finder', series: '40', category: 'Relais', variant: '2 Wechsler', color: '', model: '40.52.9.024', description: 'Steckbares Relais.', read_text: 'FINDER 40.52 24VDC', barcode_digits: '' };
    return identifyCalls === 1
      ? { ...base, match_code: '', match_confidence: 'none', match_reason: '' }
      : { ...base, match_code: 'T-FINDER-40-52-9-024', match_confidence: 'high', match_reason: 'Gleiche Typnummer 40.52.9.024' };
  });
  await openApp(page);
  await setKey(page);

  await page.setInputFiles('#noCodeInput', path.join(FIX, 'barcode.png'));
  await page.fill('#id-qty', '5');
  await page.fill('#id-hint', 'Relais');
  await page.click('.sheet [data-act=identify]');
  await expect(page.locator('#nf-name')).toHaveValue('Koppelrelais 2 Wechsler 24 V DC');
  await expect(page.locator('#nf-model')).toHaveValue('40.52.9.024');
  await expect(page.locator('#id-result')).toContainText('Gelesen: FINDER 40.52 24VDC');
  await page.click('.sheet [data-act=create-new]');
  await expect(page.locator('.sheet')).toHaveCount(0);
  const code = 'T-FINDER-40-52-9-024';
  await expect(page.locator(`#q-${code}`)).toHaveValue('5');
  await book(page);
  expect(await product(page, code)).toMatchObject({ qty: 5, maker: 'Finder', category: 'Relais', status: 'verified', hasImage: true });

  const req = calls.find((c) => kindOf(c.body) === 'identify').body;
  expect(req.model).toBe('claude-haiku-5-5');
  expect(req.output_config.format.type).toBe('json_schema');
  expect(req.messages[0].content.filter((c) => c.type === 'image')).toHaveLength(1);
  expect(req.messages[0].content.at(-1).text).toContain('Relais');

  // Next time: recognised, +2.
  await page.setInputFiles('#noCodeInput', path.join(FIX, 'barcode.png'));
  await page.fill('#id-qty', '2');
  await page.click('.sheet [data-act=identify]');
  await expect(page.locator('#id-result')).toContainText('Erkannt: Koppelrelais 2 Wechsler 24 V DC');
  await expect(page.locator('#id-result')).toContainText('Bestand 5');
  await page.click('.sheet [data-act=use-match]');
  await expect(page.locator(`#q-${code}`)).toHaveValue('2');
  const sent = calls.filter((c) => kindOf(c.body) === 'identify')[1].body.messages[0].content[0].text;
  expect(sent).toContain(code); // the catalog with own codes goes along

  // Own code works like a barcode (e.g. scanned from the printed QR label).
  await page.click('#basketClear');
  await typeCode(page, code);
  await expect(page.locator(`#q-${code}`)).toHaveValue('1');
  await page.click('.tabs [data-view=stock]');
  await page.click(`#stockList [data-ean="${code}"]`);
  await expect(page.locator('.sheet .label-card img')).toBeVisible();
});

test('ohne API-Schlüssel: Produkt ohne Barcode selbst anlegen', async ({ page }) => {
  await openApp(page);
  await page.setInputFiles('#noCodeInput', path.join(FIX, 'barcode.png'));
  await expect(page.locator('.sheet [data-act=identify]')).toHaveCount(0);
  await page.fill('#id-qty', '3');
  await page.click('.sheet [data-act=manual-new]');
  await page.fill('#nf-name', 'Abzweigdose grau');
  await page.selectOption('#nf-cat', 'Dose');
  await page.click('.sheet [data-act=create-new]');
  await expect(page.locator('#q-T-ABZWEIGDOSE-GRAU')).toHaveValue('3');
});

test('Recherche: 5 neue Produkte in einem Paket mit Websuche, gleiche Lampe unter zwei Barcodes', async ({ page }) => {
  const calls = await mockClaude(page, (body) => ({
    items: requestedEans(body).map((e) => ({
      ean: e,
      name: e === LAMP || e === LAMP_B ? 'LED-Panel 60x60 40 W 4000 K' : 'Kabelbinder 200 mm ' + e.slice(-3),
      maker: e === LAMP || e === LAMP_B ? 'Ledvance' : 'HellermannTyton',
      series: '', category: e === LAMP || e === LAMP_B ? 'Leuchte' : 'Installationsmaterial', variant: '', color: '',
      model: e === LAMP || e === LAMP_B ? 'PANEL-6060' : 'T50R', description: '', confidence: 'high', note: '',
      source: 'https://example.com/' + e, ean_on_label: e,
    })),
    duplicates: [{ ean_a: LAMP, ean_b: LAMP_B, reason: 'Gleicher Hersteller und Typ PANEL-6060' }],
  }));
  await openApp(page);
  await setKey(page, '5');
  const codes = [LAMP, LAMP_B, ean13('400000000001'), ean13('400000000002')];
  for (const c of codes) { await photoOf(page, c); await page.waitForTimeout(400); }
  await expect(page.locator('#checkChip')).toHaveText('4/5 warten auf Recherche');
  expect(calls.length).toBe(0); // no call per scan
  await typeCode(page, ean13('400000000003')); // typed: no photo, the EAN alone is researched
  await expect.poll(() => calls.length).toBe(1);
  const req = calls[0].body;
  expect(req.model).toBe('claude-haiku-5-5');
  expect(calls[0].headers['x-api-key']).toBe('sk-ant-test-key');
  expect(calls[0].headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  expect(req.tools[0]).toMatchObject({ type: 'web_search_20250305', name: 'web_search' });
  expect(requestedEans(req).sort()).toEqual([...codes, ean13('400000000003')].sort());

  await expect.poll(async () => (await product(page, LAMP)).status).toBe('verified');
  expect(await product(page, LAMP)).toMatchObject({ name: 'LED-Panel 60x60 40 W 4000 K', maker: 'Ledvance', category: 'Leuchte', model: 'PANEL-6060', source: `https://example.com/${LAMP}`, hasImage: false });

  await page.click('#openReview');
  await expect(page.locator('.dupe')).toContainText('Gleicher Hersteller und Typ PANEL-6060');
  await page.locator('.dupe [data-act=merge-dupe]').first().click();
  await expect(page.locator('.dupe')).toHaveCount(0);
  expect((await product(page, LAMP_B)).aliasOf).toBe(LAMP);
  await page.click('.tabs [data-view=scan]');
  await expect(page.locator(`#q-${LAMP}`)).toHaveValue('2');
  await typeCode(page, LAMP_B);
  await expect(page.locator(`#q-${LAMP}`)).toHaveValue('3');
});

test('Bedarfsposition, die nicht automatisch passt: Claude ordnet zu', async ({ page }) => {
  const calls = await mockClaude(page, (body) => {
    if (kindOf(body) === 'match') {
      const lines = JSON.parse(body.messages[0].content.split('Needs lines:\n')[1]);
      return { matches: lines.map((l) => ({ line_id: l.line_id, code: l.text.includes('Koppel') ? 'T-FINDER-40-52' : '', confidence: 'high', reason: 'Koppelrelais = Relais 40.52' })) };
    }
    return { items: requestedEans(body).map((e) => ({ ean: e, name: '', maker: '', series: '', category: '', variant: '', color: '', model: '', description: '', confidence: 'low', note: 'nicht gefunden', source: '', ean_on_label: '' })), duplicates: [] };
  });
  await openApp(page);
  // A tagged product in stock, created through the no-barcode form.
  await page.setInputFiles('#noCodeInput', path.join(FIX, 'barcode.png'));
  await page.fill('#id-qty', '5');
  await page.click('.sheet [data-act=manual-new]');
  await page.fill('#nf-name', 'Relais 2 Wechsler 24 V');
  await page.fill('#nf-maker', 'Finder');
  await page.fill('#nf-model', '40.52');
  await page.click('.sheet [data-act=create-new]');
  await book(page);
  await setKey(page);

  await page.click('.tabs [data-view=needs]');
  await page.fill('#needName', 'Steuerung');
  await page.click('#needForm button');
  await page.fill('#needLine', '4 Koppelrelais 24V');
  await page.press('#needLine', 'Enter');
  await page.fill('#needLine', '2 Netzteile 24 V');
  await page.press('#needLine', 'Enter');
  await expect(page.locator('#needLines .line').nth(0)).toContainText('Nicht im Lager');
  await page.click('[data-act=need-claude]');
  await expect(page.locator('#needLines .line').nth(0)).toContainText('Relais 2 Wechsler 24 V · 4 im Lager · komplett');
  await expect(page.locator('#needLines .line').nth(1)).toContainText('Nicht im Lager · 2 bestellen');
  const req = calls.find((c) => kindOf(c.body) === 'match').body;
  expect(req.output_config.format.type).toBe('json_schema');
});

test('unlesbares Etikett geht sofort an Claude, mit Foto', async ({ page }) => {
  const calls = await mockClaude(page, (body) => ({
    items: requestedEans(body).map((e) => ({ ean: e, name: 'Wago 221-413 Verbindungsklemme', maker: 'WAGO', series: '221', category: 'Klemme', variant: '3-polig', color: '', model: '221-413', description: '', confidence: 'medium', note: '', source: '', ean_on_label: '' })),
    duplicates: [],
  }));
  await openApp(page, { ocr: 'bad' });
  await setKey(page, '20');
  const code = ean13('401234567890');
  await photoOf(page, code);
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0].body.messages[0].content.filter((c) => c.type === 'image')).toHaveLength(1);
  await expect.poll(async () => (await product(page, code)).status).toBe('verified');
  expect((await product(page, code)).category).toBe('Klemme');
});

test('falscher API-Schlüssel: klare Meldung, Produkte warten weiter', async ({ page }) => {
  await page.route('https://api.anthropic.com/**', (route) => route.request().method() === 'OPTIONS'
    ? route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
    : route.fulfill({ status: 401, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) }));
  await openApp(page, { ocr: 'bad' });
  await setKey(page);
  const code = ean13('401234567891');
  await photoOf(page, code);
  await page.click('#openReview');
  await expect(page.locator('#checkPanel')).toContainText('API-Schlüssel wurde abgelehnt', { timeout: 15_000 });
  expect((await product(page, code)).status).toBe('error');
});

test('Excel: Datei enthält alle Blätter und lädt auf einem neuen Gerät alles wieder', async ({ page, browser }) => {
  await openApp(page);
  for (let i = 0; i < 2; i++) await typeCode(page, LAMP);
  await book(page);
  await expect(page.locator('#excelDot')).toBeVisible();
  await editProduct(page, LAMP, { name: 'LED-Panel 60x60', category: 'Leuchte' });
  await page.click('.tabs [data-view=jobs]');
  await page.fill('#jobName', 'Halle A');
  await page.click('#jobForm button');
  await typeCode(page, LAMP);
  await book(page);
  await page.click('.tabs [data-view=needs]');
  await page.fill('#needName', 'Halle A Bedarf');
  await page.click('#needForm button');
  await page.fill('#needLine', '5 LED-Panel');
  await page.press('#needLine', 'Enter');

  await page.click('#openExcel');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.sheet [data-act=excel-save]')]);
  expect(dl.suggestedFilename()).toMatch(/^lager-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const file = path.join(FIX, 'export.xlsx');
  await dl.saveAs(file);
  await expect(page.locator('#excelDot')).toBeHidden();

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  expect(wb.worksheets.map((w) => w.name)).toEqual(['Übersicht', 'Bestand', 'Bedarf', 'Bestellliste', 'Buchungen', 'Aufträge']);
  const head = (ws) => ws.getRow(1).values;
  const st = wb.getWorksheet('Bestand');
  const row = st.getRow(2).values;
  expect(row[head(st).indexOf('Produkt')]).toBe('LED-Panel 60x60');
  expect(row[head(st).indexOf('Bestand')]).toBe(1);
  expect(row[head(st).indexOf('Kategorie')]).toBe('Leuchte');
  const lg = wb.getWorksheet('Buchungen');
  expect(lg.rowCount).toBe(3);
  expect(lg.getRow(3).values[head(lg).indexOf('Auftrag')]).toBe('Halle A');
  const nd = wb.getWorksheet('Bedarf');
  const ndRow = nd.getRow(2).values;
  expect(ndRow[head(nd).indexOf('Benötigt')]).toBe(5);
  expect(ndRow[head(nd).indexOf('Im Lager')]).toBe(1);
  expect(wb.getWorksheet('Bestellliste').getRow(2).values[head(wb.getWorksheet('Bestellliste')).indexOf('Menge')]).toBe(4);

  const page2 = await browser.newPage();
  await openApp(page2);
  await page2.click('#openExcel');
  await page2.setInputFiles('#excel-import', file);
  await expect(page2.locator('.sheet')).toContainText('1 Produkte, 2 Buchungen, 1 Aufträge, 1 Bedarfslisten');
  await page2.click('.sheet [data-act=do-import]');
  await expect.poll(async () => (await product(page2, LAMP))?.qty).toBe(1);
  await page2.click('.tabs [data-view=needs]');
  await expect(page2.locator('#needsItems')).toContainText('Halle A Bedarf');
  await expect(page2.locator('#needsItems')).toContainText('4 fehlen');
});

test('falsch getippter Barcode wird abgelehnt, Handscanner-Prellen ignoriert', async ({ page }) => {
  await openApp(page);
  await page.fill('#codeInput', '4037293393361');
  await page.press('#codeInput', 'Enter');
  await expect(page.locator('#scanMsg')).toContainText('Prüfziffer stimmt nicht');
  await page.fill('#codeInput', EVN); await page.press('#codeInput', 'Enter');
  await page.fill('#codeInput', EVN); await page.press('#codeInput', 'Enter');
  await page.waitForTimeout(500);
  await expect(page.locator(`#q-${EVN}`)).toHaveValue('1');
});

test('Barcode aus einem Foto', async ({ page }) => {
  await openApp(page);
  await page.setInputFiles('#photoInput', path.join(FIX, 'barcode.png'));
  await expect(page.locator(`#q-${EVN}`)).toHaveValue('1', { timeout: 15_000 });
  await expect.poll(async () => (await product(page, EVN))?.status).toBe('ocr');
});

test('Daten bleiben nach Neuladen erhalten', async ({ page }) => {
  await openApp(page);
  const url = page.url();
  await typeCode(page, LAMP);
  await typeCode(page, LAMP);
  await page.reload();
  await page.waitForFunction(() => window.__lager);
  await expect(page.locator(`#q-${LAMP}`)).toHaveValue('2');
  await book(page);
  await page.goto(url);
  await page.waitForFunction(() => window.__lager);
  expect((await product(page, LAMP)).qty).toBe(2);
});
