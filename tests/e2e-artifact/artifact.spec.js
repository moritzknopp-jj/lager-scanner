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
    const kind = /identify products for the stock list[\s\S]*Each item was scanned/.test(prompt) ? 'research' : /from the attached photo/.test(prompt) ? 'identify' : /needs list/.test(prompt) ? 'match' : 'other';
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
  await expect(page.locator('#photoBtn')).toContainText('Barcode fotografieren');
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

  await page.setInputFiles('#photoInput', path.join(FIX, 'barcode.png'));
  await expect(page.locator(`#q-${EVN}`)).toHaveValue('1', { timeout: 15_000 });
  await expect.poll(async () => (await product(page, EVN))?.status, { timeout: 15_000 }).toBe('verified');
  expect(await product(page, EVN)).toMatchObject({ name: 'LED-Netzteil 24 V DC 0,1-18 W IP20', maker: 'EVN Lichttechnik', model: 'SLK24018', category: 'Netzteil/Treiber' });
  const c = calls.find((x) => x.kind === 'research');
  expect(c.model).toBe('claude-haiku-5-5');
  expect(c.nImages).toBe(1); // Claude reads the label photo itself
  expect(eansIn(c.prompt)).toEqual([EVN]);
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
  await page.setInputFiles('#noCodeInput', path.join(FIX, 'barcode.png'));
  await page.fill('#id-qty', '5');
  await page.click('.sheet [data-act=identify]');
  await expect(page.locator('#nf-name')).toHaveValue('Koppelrelais 2 Wechsler 24 V DC');
  await page.click('.sheet [data-act=create-new]');
  const code = 'T-FINDER-40-52-9-024';
  await expect(page.locator(`#q-${code}`)).toHaveValue('5');
  await book(page);
  expect((await product(page, code)).qty).toBe(5);
  expect(calls[0]).toMatchObject({ kind: 'identify', nImages: 1, model: 'claude-haiku-5-5' });

  await page.setInputFiles('#noCodeInput', path.join(FIX, 'barcode.png'));
  await page.fill('#id-qty', '2');
  await page.click('.sheet [data-act=identify]');
  await expect(page.locator('#id-result')).toContainText('Erkannt: Koppelrelais 2 Wechsler 24 V DC');
  await page.click('.sheet [data-act=use-match]');
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
  await page.setInputFiles('#noCodeInput', path.join(FIX, 'barcode.png'));
  await page.click('.sheet [data-act=identify]');
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
  // The phone books 9 more: the PC sees it without reloading.
  await page.evaluate((code) => {
    const path = 'catalog/s' + code.slice(-2);
    const d = window.__fakeDb.get(path);
    d.products[code] = { ...d.products[code], qty: 10, name: 'LED-Netzteil vom Handy' };
    window.__fakeDb.remoteSet(path, d);
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
