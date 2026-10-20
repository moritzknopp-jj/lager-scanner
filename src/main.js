import * as store from './db.js';
import {
  normalizeCode, resolveMaster, RepeatGuard, basketAdd, basketSet, basketTotal, shortages, guessFromOcr, ocrUsable, shouldRunCheck,
  today, cmpText, STATUS_LABEL, CATEGORIES, makeTagCode, isTag, parseNeedText, suggestProducts, computeNeed, orderList, takenForNeed, groupByCategory,
} from './logic.js';
import { startCamera, captureFrame, decodePhoto, shrinkPhoto } from './scanner.js';

// Heavy parts load on first use so the scanner opens fast.
const lazyOcr = () => import('./ocr.js');
const lazyAi = () => import('./ai.js');
const lazyExcel = () => import('./excel.js');
const lazyQr = () => import('qrcode');

// Built twice: for GitHub Pages (Claude via API key) and as a claude.ai artifact (Claude via the subscription).
const ARTIFACT = typeof __ARTIFACT__ !== 'undefined' && __ARTIFACT__;
const DEFAULT_BATCH = ARTIFACT ? 5 : 10;

const params = new URLSearchParams(location.search);
const storeReady = store.openStore(params.get('db') || undefined);

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (t) => new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const fmtDate = (t) => new Date(t).toLocaleDateString('de-DE');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const S = {
  products: {}, jobs: {}, needs: {}, meta: {},
  basket: [], mode: 'in', jobId: '',
  view: 'scan', needId: null, recent: [], logItems: [], logDone: false,
  camera: null, checking: false, checkRetryAt: 0, shortOk: false,
  dirty: 0, savedAt: 0, fileHandle: null, fileOk: false,
};
const guard = new RepeatGuard();
const setting = (k, d) => (S.meta[k] === undefined || S.meta[k] === null ? d : S.meta[k]);
const aiOn = () => (ARTIFACT ? !!S.ai?.text : !!setting('apiKey', ''));
const aiImages = () => (ARTIFACT ? !!S.ai?.images : aiOn());
async function setSetting(k, v) { S.meta[k] = v; await store.setMeta(k, v); }

// ---------- small UI helpers ----------
let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3000);
}
function scanMsg(html, kind = 'info') { $('scanMsg').innerHTML = html ? `<div class="msg ${kind}">${html}</div>` : ''; }
let audio;
function beep(ok = true) {
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(); const g = audio.createGain();
    o.frequency.value = ok ? 1250 : 330; g.gain.value = 0.08;
    o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime + (ok ? 0.07 : 0.25));
  } catch { /* optional */ }
  try { navigator.vibrate?.(ok ? 40 : [80, 60, 80]); } catch { /* optional */ }
}
const master = (code) => resolveMaster(S.products, code);
const pname = (code) => master(code)?.name || 'Unbenanntes Produkt';
const subline = (p) => [p.maker, p.series, p.variant, p.color, p.model].filter(Boolean).join(' · ');
function statusPill(p) {
  if (!p) return '';
  const cls = { new: 'warn', ocr: 'warn', error: 'bad', manual: 'bad', verified: 'ok', edited: 'ok' }[p.status] || '';
  return `<span class="pill ${cls}">${esc(STATUS_LABEL[p.status] || p.status)}</span>`;
}
// All numbers known for a product, without duplicates (for pricing it later).
function mergeIds(...parts) {
  const out = [];
  for (const part of parts) for (const x of String(part || '').split(/[,;\n]+/)) { const t = x.trim(); if (t && !out.includes(t)) out.push(t); }
  return out.join(', ');
}
const unitOf = (p) => (p?.unit === 'm' ? 'm' : '');
const looksLikeText = (v) => /\s/.test(v.trim()) || /[a-zäöüß]/.test(v);
const needsAttention = (p) => !p.aliasOf && ['new', 'ocr', 'error', 'manual'].includes(p.status);
const catOptions = (sel) => ['', ...CATEGORIES].map((c) => `<option value="${esc(c)}" ${c === (sel || '') ? 'selected' : ''}>${esc(c || '– Kategorie –')}</option>`).join('');

async function saveSession() { await setSetting('session', { mode: S.mode, jobId: S.jobId, basket: S.basket }); }

// Every change to stored data goes through here so the Excel file follows.
let saveTimer;
function changed() {
  S.dirty++;
  setSetting('dirty', S.dirty);
  if (S.fileHandle && S.fileOk) { clearTimeout(saveTimer); saveTimer = setTimeout(() => saveExcel({ quiet: true }), 1500); }
  renderExcelState();
}

// ---------- scanning ----------
async function handleCode(raw, source = 'key', image = null) {
  const n = normalizeCode(raw);
  if (n.error) { beep(false); scanMsg(esc(n.error), 'err'); return; }
  const code = n.code;
  if (source !== 'camera' && !guard.shouldCount(code, Date.now(), 'key')) return;
  if (!S.products[code]) await createProduct(code, image);
  const m = master(code);
  S.basket = basketAdd(S.basket, m.ean, 1);
  S.shortOk = false;
  await saveSession();
  beep(true);
  const line = S.basket.find((l) => l.ean === m.ean);
  $('camLast').textContent = `+1 ${m.name || 'Neues Produkt'} (${line.qty})`;
  scanMsg('');
  flashCamera();
  renderBasket();
}
function flashCamera() {
  const cam = document.querySelector('.camera');
  cam.classList.add('flash');
  setTimeout(() => cam.classList.remove('flash'), 180);
}

async function createProduct(code, image) {
  const now = Date.now();
  const p = { ean: code, name: '', maker: '', series: '', category: '', variant: '', color: '', model: '', description: '', qty: 0, status: 'new', aliases: [], aliasOf: null, hasImage: false, created: now, updated: now };
  S.products[code] = p;
  await store.putProduct(p);
  changed();
  readNewLabel(code, image); // background: read label, then queue for research
}

async function readNewLabel(code, imagePromise) {
  let p = S.products[code];
  const blob = await Promise.resolve(imagePromise).catch(() => null);
  if (!blob) {
    // No photo: the barcode alone is enough for a web search.
    p = { ...p, status: 'ocr', ocrText: '', aiNote: '', updated: Date.now() };
    S.products[code] = p; await store.putProduct(p); renderAll(); maybeRunCheck(); return;
  }
  await store.putImage(code, await shrinkPhoto(blob, 1400).catch(() => blob));
  p = { ...S.products[code], hasImage: true };
  if (ARTIFACT) {
    // claude.ai version: no on-device text reading; Claude looks at the photo itself.
    p = { ...p, status: 'ocr', aiNote: '', updated: Date.now() };
    S.products[code] = p; await store.putProduct(p); renderAll(); maybeRunCheck(); return;
  }
  S.products[code] = p; await store.putProduct(p);
  try {
    const ocr = window.__lagerTestOcr ? await window.__lagerTestOcr(blob) : await (await lazyOcr()).readLabel(blob);
    const usable = ocrUsable(ocr.text, ocr.confidence);
    const g = usable ? guessFromOcr(ocr.text) : { name: '', maker: '', model: '' };
    const cur = S.products[code];
    if (!cur || cur.status === 'edited' || cur.status === 'verified') return;
    p = {
      ...cur, ocrText: ocr.text.slice(0, 4000), ocrConf: ocr.confidence, guess: g,
      name: cur.name || g.name, maker: cur.maker || g.maker, model: cur.model || g.model,
      status: usable ? 'ocr' : 'error', aiNote: usable ? '' : 'Etikett nicht lesbar. Claude schaut sich das Foto an.',
      updated: Date.now(),
    };
  } catch (e) {
    p = { ...S.products[code], status: 'error', aiNote: 'Etikett lesen fehlgeschlagen: ' + (e.message || e), updated: Date.now() };
  }
  S.products[code] = p;
  await store.putProduct(p);
  renderAll();
  maybeRunCheck();
}

async function toggleCamera() {
  if (S.camera) { stopCamera(); return; }
  try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); audio.resume?.(); } catch { /* optional */ }
  const video = $('video');
  try {
    video.hidden = false;
    S.camera = await startCamera(video, (text) => {
      const n = normalizeCode(text);
      if (!guard.shouldCount(n.code || text, Date.now(), 'camera')) return;
      const known = n.code && S.products[n.code];
      handleCode(text, 'camera', known ? null : captureFrame(video));
    });
    $('camIdle').hidden = true; $('camHud').hidden = false;
    $('camLast').textContent = 'Barcode in den Rahmen halten';
  } catch (e) {
    video.hidden = true; S.camera = null;
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    scanMsg(denied ? 'Kamerazugriff ist blockiert. Bitte in den Browser-Einstellungen die Kamera für diese Seite erlauben, oder „Foto vom Barcode“ nutzen.' : 'Kamera startet nicht: ' + esc(e.message || e.name), 'err');
  }
}
function stopCamera() {
  try { S.camera?.stop(); } catch { /* already stopped */ }
  S.camera = null;
  $('video').hidden = true; $('camIdle').hidden = false; $('camHud').hidden = true;
}

// ---------- one button: scan a product ----------
// Photo -> barcode found: that is the product's code. No barcode: Claude recognises the product.
// Either way the app then asks how many.
async function scanProduct(file) {
  if (!file) return;
  scanMsg('Suche Barcode…');
  try {
    const small = await shrinkPhoto(file);
    const raw = await decodePhoto(file);
    const n = raw ? normalizeCode(raw) : null;
    scanMsg('');
    if (n?.code) {
      const isNew = !S.products[n.code];
      if (isNew) await createProduct(n.code, small); // Claude researches it from this photo
      beep(true);
      qtySheet(master(n.code).ean, { isNew });
      return;
    }
    identifySheet(small);
  } catch (e) { scanMsg(esc(e.message), 'err'); }
}

async function onScanClick(e) {
  // With the live camera on (GitHub version) take the current frame instead of a new photo.
  if (!S.camera) return;
  e.preventDefault();
  const blob = await captureFrame($('video'));
  if (blob) scanProduct(blob);
}

// "How many?" after every scanned product, so 24 lamps are one scan plus "24".
function qtySheet(code, { isNew = false, note = '' } = {}) {
  const p = master(code);
  const inBasket = S.basket.find((l) => l.ean === p.ean)?.qty || 0;
  const verb = S.mode === 'out' ? 'entnehmen' : 'hinzufügen';
  const u = unitOf(p);
  openSheet(`
    <div class="top"><h2>${u ? 'Wie viele Meter' : 'Wie viele'} ${verb}?</h2><button class="small" data-act="close">Abbrechen</button></div>
    <div class="panel">
      <b>${esc(p.name || (isNew ? 'Neues Produkt' : 'Unbenanntes Produkt'))}</b>
      ${subline(p) ? `<span class="muted">${esc(subline(p))}</span>` : ''}
      <span class="muted"><span class="mono">${esc(p.ean)}</span> · Bestand ${p.qty || 0}${u ? ' m' : ''}${inBasket ? ` · schon im Korb: ${inBasket}${u ? ' m' : ''}` : ''}</span>
      ${note ? `<span>${esc(note)}</span>` : ''}
      ${isNew ? `<span class="muted">Neu angelegt${aiOn() ? ' – Claude erkennt es am Foto' : ''}.</span>` : ''}
    </div>
    <div class="qtybig">
      <button data-act="q-step" data-d="-1" aria-label="Eins weniger">−</button>
      <input id="qs-qty" type="number" inputmode="numeric" min="1" value="1" aria-label="Anzahl">
      <button data-act="q-step" data-d="1" aria-label="Eins mehr">+</button>
    </div>
    <div class="row wrap-gap quick">${[1, 5, 10, 20, 50].map((n) => `<button class="small" data-act="q-set" data-n="${n}">${n}</button>`).join('')}</div>
    <button class="primary big" data-act="q-ok" id="qs-ok">+1${u ? ' m' : ''} in den Korb</button>
  `, async (act, el) => {
    const inp = $('qs-qty');
    if (act === 'close') closeSheet();
    if (act === 'q-step') inp.value = Math.max(1, (parseInt(inp.value, 10) || 1) + Number(el.dataset.d));
    if (act === 'q-set') inp.value = el.dataset.n;
    if (act === 'q-step' || act === 'q-set') inp.dispatchEvent(new Event('input'));
    if (act === 'q-ok') {
      const q = Math.max(1, parseInt(inp.value, 10) || 1);
      closeSheet();
      await addToBasket(p.ean, q);
    }
  });
  const inp = $('qs-qty');
  const label = () => { $('qs-ok').textContent = `+${Math.max(1, parseInt(inp.value, 10) || 1)}${u ? ' m' : ''} in den Korb`; };
  inp.addEventListener('input', label);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('qs-ok').click(); } });
  inp.focus(); inp.select();
}

// ---------- products without barcode ----------
function identifySheet(blob, { text = '' } = {}) {
  const url = blob ? URL.createObjectURL(blob) : '';
  const ai = blob ? aiImages() : aiOn();
  openSheet(`
    <div class="top"><h2>${blob ? 'Kein Barcode gefunden' : 'Produkt hinzufügen'}</h2><button class="small" data-act="close">Abbrechen</button></div>
    ${url ? `<img class="thumb" src="${url}" alt="Foto des Produkts">` : `<div><b>„${esc(text)}“</b></div>`}
    <div id="id-result">${ai ? '<div class="msg info">Claude erkennt das Produkt…</div>' : ''}</div>
    <div class="row" id="id-actions" ${ai ? 'hidden' : ''}>
      <input id="id-hint" class="grow" placeholder="${blob ? 'Hinweis, z.B. „Busch-Jaeger Rahmen 2-fach“' : 'Genauer beschreiben'}" value="${esc(text)}">
      ${ai ? '<button data-act="identify">Nochmal erkennen</button>' : ''}
    </div>
    <button class="ghost" data-act="manual-new" id="id-manual">${ai ? 'Selbst anlegen' : 'Produkt anlegen'}</button>
    ${ai ? '' : `<span class="muted">${ARTIFACT ? 'Claude ist gerade nicht verfügbar (z.B. Zugriff abgelehnt oder Limit erreicht).' : 'Mit einem API-Schlüssel in den Einstellungen erkennt Claude das Produkt am Foto.'}</span>`}
  `, async (act, el) => {
    if (act === 'close') { closeSheet(); if (url) URL.revokeObjectURL(url); }
    if (act === 'identify') await runIdentify(blob);
    if (act === 'manual-new') showNewForm(blob ? {} : { name: ($('id-hint')?.value || text).trim() });
    if (act === 'use-match') { closeSheet(); if (url) URL.revokeObjectURL(url); qtySheet(el.dataset.code, { note: el.dataset.note }); }
    if (act === 'create-new') {
      const f = readNewForm();
      if (!f.name) { toast('Bitte mindestens einen Namen eingeben.'); return; }
      const qty = Math.max(1, parseInt($('nf-qty').value, 10) || 1);
      const code = await createTagged(f, blob);
      closeSheet(); if (url) URL.revokeObjectURL(url);
      await addToBasket(code, qty);
    }
  });
  if (ai) runIdentify(blob);
  else if (!blob) showNewForm({ name: text });
}

async function runIdentify(blob) {
  const res = $('id-result');
  res.innerHTML = '<div class="msg info">Claude erkennt das Produkt…</div>';
  $('id-actions').hidden = true;
  try {
    const { identifyPhoto, lookupText, compactCatalog } = await lazyAi();
    const hint = ($('id-hint')?.value || '').trim();
    const r = blob
      ? await identifyPhoto({ apiKey: setting('apiKey', ''), image: blob, hint, catalog: compactCatalog(S.products) })
      : await lookupText({ apiKey: setting('apiKey', ''), text: hint, catalog: compactCatalog(S.products) });
    if (!$('id-result')) return; // sheet closed meanwhile
    const digits = normalizeCode(r.barcode_digits || r.ean || '').code;
    const m = r.match_code && S.products[r.match_code] ? master(r.match_code) : digits && S.products[digits] ? master(digits) : null;
    $('id-actions').hidden = false;
    if (m && r.match_confidence !== 'low' && r.match_confidence !== 'none') {
      res.innerHTML = `<div class="msg ok"><b>Erkannt:</b> ${esc(m.name || m.ean)}<br><span class="muted">${esc(subline(m))} · Bestand ${m.qty || 0}</span>${r.match_reason ? `<br>${esc(r.match_reason)}` : ''}</div>
        <div class="row"><button class="primary grow" data-act="use-match" data-code="${esc(m.ean)}" data-note="${esc('Erkannt: ' + (r.match_reason || ''))}">Weiter: Anzahl</button><button class="grow" data-act="manual-new">Anderes Produkt</button></div>`;
      return;
    }
    showNewForm({ ...r, code: digits || '', fromKnowledge: !blob || !r.barcode_digits }, r.read_text ? `Gelesen: ${r.read_text}` : '');
  } catch (e) {
    if (!$('id-result')) return;
    res.innerHTML = `<div class="msg err">${esc(e.message)}</div>`;
    $('id-actions').hidden = false;
  }
}

function showNewForm(f, note = '') {
  $('id-manual').hidden = true;
  $('id-result').innerHTML = `
    ${note ? `<div class="muted">${esc(note)}</div>` : ''}
    <div class="panel">
      <div class="label">Neues Produkt${f.code ? ` · EAN ${esc(f.code)} erkannt` : ' · bekommt einen eigenen Code'}</div>
      <input id="nf-name" placeholder="Produktname" value="${esc(f.name || '')}">
      <div class="row"><select id="nf-cat" class="grow">${catOptions(f.category)}</select><input id="nf-variant" class="grow" placeholder="Variante, z.B. 2-fach" value="${esc(f.variant || '')}"></div>
      <div class="row"><input id="nf-maker" class="grow" placeholder="Hersteller" value="${esc(f.maker || '')}"><input id="nf-series" class="grow" placeholder="Serie" value="${esc(f.series || '')}"></div>
      <div class="row"><input id="nf-model" class="grow" placeholder="Artikel-/Typnummer" value="${esc(f.model || '')}"><input id="nf-color" class="grow" placeholder="Farbe" value="${esc(f.color || '')}"></div>
      <div class="row"><input id="nf-order" class="grow" placeholder="Bestellnr. (z.B. 2CKA…)" value="${esc(f.order_number || '')}"><select id="nf-unit" class="grow" aria-label="Einheit">${['Stück', 'm'].map((u) => `<option ${((f.unit === 'm' ? 'm' : 'Stück') === u) ? 'selected' : ''}>${u}</option>`).join('')}</select></div>
      <input id="nf-ids" placeholder="Alle Nummern (EAN, Artikel-, Bestellnr. …)" value="${esc(mergeIds(f.code, f.model, f.order_number, f.all_ids))}">
      <input type="hidden" id="nf-code" value="${esc(f.code || '')}">
      <input type="hidden" id="nf-know" value="${f.fromKnowledge && f.code ? '1' : ''}">
      <input type="hidden" id="nf-desc" value="${esc(f.description || '')}">
      <input type="hidden" id="nf-read" value="${esc(f.read_text || '')}">
      <div class="row"><label class="label" for="nf-qty" style="flex:0 0 auto">Anzahl</label><input id="nf-qty" type="number" inputmode="numeric" min="1" value="1" style="max-width:110px"></div>
      <button class="primary" data-act="create-new">Anlegen und in den Korb</button>
    </div>`;
}
function readNewForm() {
  const v = (id) => ($(id)?.value || '').trim();
  return { name: v('nf-name'), category: v('nf-cat'), variant: v('nf-variant'), maker: v('nf-maker'), series: v('nf-series'), model: v('nf-model'), color: v('nf-color'), code: v('nf-code'), description: v('nf-desc'), read: v('nf-read'), orderNo: v('nf-order'), ids: v('nf-ids'), unit: v('nf-unit') === 'm' ? 'm' : 'Stück', fromKnowledge: !!v('nf-know') };
}

async function createTagged(f, blob) {
  const code = f.code && !S.products[f.code] ? f.code : makeTagCode(f, S.products);
  const now = Date.now();
  const p = {
    ean: code, name: f.name, maker: f.maker, series: f.series, category: f.category, variant: f.variant, color: f.color, model: f.model,
    description: f.description, ocrText: f.read, orderNo: f.orderNo || '', ids: mergeIds(code, f.ids), unit: f.unit || 'Stück',
    qty: 0, status: 'verified', aliases: [], aliasOf: null, hasImage: !!blob, created: now, updated: now,
    ...(f.fromKnowledge && !isTag(code) ? { aiNote: 'EAN aus Claudes Produktwissen, nicht vom Etikett. Beim ersten Scan des echten Barcodes prüfen.' } : {}),
  };
  S.products[code] = p;
  await store.putProduct(p);
  if (blob) await store.putImage(code, await shrinkPhoto(blob, 900));
  changed();
  return code;
}

async function addToBasket(code, qty) {
  S.basket = basketAdd(S.basket, master(code).ean, qty);
  S.shortOk = false;
  await saveSession();
  beep(true);
  renderAll();
  showView('scan');
  toast(`+${qty} ${pname(code)}`);
}

// ---------- booking ----------
async function bookBasket() {
  if (!S.basket.length) return;
  const kind = S.mode;
  if (kind === 'out' && !S.jobs[S.jobId]) { scanMsg('Bitte vor dem Entnehmen einen Auftrag wählen oder anlegen.', 'err'); return; }
  if (kind === 'out' && !S.shortOk && shortages(S.basket, S.products).length) { renderBasket(true); return; }
  const lines = S.basket.map((l) => ({ ean: master(l.ean).ean, qty: l.qty }));
  try {
    const res = await store.bookLines({ kind, lines, jobId: kind === 'out' ? S.jobId : null });
    for (const p of res.products) S.products[p.ean] = p;
    if (res.job) S.jobs[res.job.id] = res.job;
    const total = basketTotal(lines);
    const left = res.products.slice(0, 5).map((p) => `${esc(p.name || p.ean)}: <b>${p.qty}</b> übrig`).join('<br>');
    S.basket = []; S.shortOk = false;
    await saveSession();
    scanMsg(`${kind === 'in' ? 'Eingebucht' : 'Entnommen'}: ${plural(total, 'Stück', 'Stück')}${kind === 'out' ? ' für ' + esc(S.jobs[S.jobId].name) : ''}.<br>${left}`, 'ok');
    navigator.storage?.persist?.().catch(() => {});
    changed();
    await refreshLogs();
    renderAll();
  } catch (e) { scanMsg(esc(e.message), 'err'); }
}

async function undo(id) {
  try {
    const r = await store.undoEntry(id);
    if (r.product) S.products[r.product.ean] = r.product;
    if (r.job) S.jobs[r.job.id] = r.job;
    changed();
    await refreshLogs();
    renderAll();
    toast('Buchung storniert');
  } catch (e) { toast(e.message); }
}

async function refreshLogs() {
  S.recent = await store.recentLog(6);
  S.logItems = await store.recentLog(200);
  S.logDone = S.logItems.length < 200;
}

// ---------- research agent (Claude Haiku) ----------
function checkStats() {
  const list = Object.values(S.products).filter((p) => !p.aliasOf);
  return {
    waiting: list.filter((p) => p.status === 'ocr').length,
    failed: list.filter((p) => p.status === 'error' && p.hasImage).length,
    reading: list.filter((p) => p.status === 'new').length,
  };
}

async function maybeRunCheck(force = false) {
  if (S.checking) return;
  const apiKey = setting('apiKey', '');
  if (!aiOn()) { renderAll(); return; }
  if (!force && Date.now() < S.checkRetryAt) return;
  const batchSize = setting('batchSize', DEFAULT_BATCH);
  if (!force && !shouldRunCheck(S.products, batchSize).run) return;
  const candidates = Object.values(S.products).filter((p) => !p.aliasOf && (p.status === 'ocr' || (p.status === 'error' && p.hasImage)));
  if (!candidates.length) { if (force) toast('Nichts wartet auf Recherche.'); return; }
  S.checking = true; renderAll();
  let ok = false;
  try {
    const { researchBatch, compactCatalog, MAX_ITEMS_PER_CALL } = await lazyAi();
    const batch = candidates.slice(0, MAX_ITEMS_PER_CALL);
    const items = [];
    for (const p of batch) {
      const image = p.status === 'error' || (ARTIFACT && p.hasImage) ? await store.getImage(p.ean) : null;
      if (image) items.push({ ean: p.ean, image });
      else items.push({ ean: p.ean, ocrText: p.ocrText || '' });
    }
    const known = Object.fromEntries(Object.entries(S.products).filter(([, p]) => p.status === 'verified' || p.status === 'edited'));
    const res = await researchBatch({ apiKey, items, catalog: compactCatalog(known) });
    const byEan = Object.fromEntries(res.items.map((i) => [String(i.ean), i]));
    for (const p of batch) {
      const r = byEan[p.ean];
      const cur = S.products[p.ean];
      if (!cur || cur.status === 'edited') continue;
      if (!r) {
        const tries = (cur.checkTries || 0) + 1;
        const np = { ...cur, checkTries: tries, ...(tries >= 2 ? { status: 'manual', aiNote: 'Claude hat zu diesem Produkt nichts geliefert. Bitte von Hand ausfüllen.' } : {}) };
        S.products[p.ean] = np; await store.putProduct(np);
        continue;
      }
      const onLabel = r.ean_on_label ? normalizeCode(r.ean_on_label).code : '';
      const mismatch = onLabel && onLabel !== p.ean && !(cur.aliases || []).includes(onLabel);
      const good = r.name && r.confidence !== 'low' && !mismatch;
      const pick = (k) => r[k] || cur[k] || '';
      const np = {
        ...cur, name: pick('name'), maker: pick('maker'), series: pick('series'), category: pick('category'), variant: pick('variant'),
        color: pick('color'), model: pick('model'), description: pick('description'), source: r.source || cur.source || '',
        orderNo: r.order_number || cur.orderNo || '', ids: mergeIds(cur.ids, r.all_ids, p.ean), unit: r.unit === 'm' ? 'm' : cur.unit || 'Stück',
        status: good ? 'verified' : 'manual',
        aiNote: mismatch ? `Etikett zeigt EAN ${onLabel}, gescannt wurde ${p.ean}. Bitte prüfen.` : r.note || (good ? '' : 'Claude war sich nicht sicher. Bitte prüfen.'),
        checkedAt: Date.now(), updated: Date.now(),
      };
      S.products[p.ean] = np;
      await store.putProduct(np);
      if (good && np.hasImage && !isTag(np.ean)) { await store.deleteImage(p.ean); np.hasImage = false; await store.putProduct(np); }
    }
    await addDupes(res.duplicates);
    await setSetting('lastCheck', { t: Date.now(), n: batch.length, searches: res.searches || 0, error: '' });
    S.checkRetryAt = 0;
    ok = true;
    changed();
    toast(`Claude hat ${plural(batch.length, 'Produkt', 'Produkte')} recherchiert`);
  } catch (e) {
    await setSetting('lastCheck', { t: Date.now(), n: 0, error: e.message || String(e) });
    S.checkRetryAt = Date.now() + 2 * 60 * 1000;
    if (force) toast(e.message);
  } finally {
    S.checking = false;
    renderAll();
  }
  if (ok && shouldRunCheck(S.products, setting('batchSize', DEFAULT_BATCH)).run) setTimeout(() => maybeRunCheck(), 500);
}

async function addDupes(list) {
  const dupes = [...setting('dupes', [])];
  const dismissed = new Set(setting('dismissed', []));
  const key = (a, b) => [a, b].sort().join('|');
  const have = new Set(dupes.map((d) => key(d.a, d.b)));
  for (const d of list || []) {
    const a = String(d.ean_a), b = String(d.ean_b);
    if (a === b || !S.products[a] || !S.products[b] || S.products[a].aliasOf || S.products[b].aliasOf) continue;
    const k = key(a, b);
    if (have.has(k) || dismissed.has(k)) continue;
    dupes.push({ a, b, reason: String(d.reason || '').slice(0, 200) });
    have.add(k);
  }
  await setSetting('dupes', dupes);
}

async function merge(fromCode, intoCode) {
  try {
    await store.mergeProducts(fromCode, intoCode);
    const all = await store.loadAll();
    S.products = all.products; S.jobs = all.jobs; S.needs = all.needs;
    S.basket = S.basket.reduce((acc, l) => basketAdd(acc, master(l.ean).ean, l.qty), []);
    await saveSession();
    await setSetting('dupes', setting('dupes', []).filter((d) => S.products[d.a] && S.products[d.b] && !S.products[d.a].aliasOf && !S.products[d.b].aliasOf));
    changed();
    await refreshLogs();
    renderAll();
    toast('Zusammengeführt. Beide Codes buchen jetzt dasselbe Produkt.');
  } catch (e) { toast(e.message); }
}

// ---------- needs lists ----------
const lineId = () => Math.random().toString(36).slice(2, 9);

async function saveNeed(n) {
  S.needs[n.id] = n;
  await store.putNeed(n);
  changed();
}

// Need edits run one after another on the latest list, so fast typing never loses a line.
let needChain = Promise.resolve();
function addNeedLine(n, raw, code = undefined) {
  const job = needChain.then(() => addNeedLineNow(S.needs[n.id], raw, code));
  needChain = job.catch(() => {});
  return job;
}
async function addNeedLineNow(n, raw, code) {
  const { qty, text } = parseNeedText(raw);
  if (!text || !n) return;
  let pick = code;
  if (pick === undefined) {
    const s = suggestProducts(text, S.products, 2);
    pick = s[0] && s[0].score >= 0.75 && (!s[1] || s[1].score < s[0].score) ? s[0].code : null;
  }
  await saveNeed({ ...n, lines: [...(n.lines || []), { id: lineId(), text, qty, code: pick, by: pick ? 'auto' : null }] });
}

async function claudeMatch(n) {
  const open = (n.lines || []).filter((l) => !l.code);
  if (!open.length) { toast('Alle Positionen sind schon zugeordnet.'); return; }
  toast('Claude ordnet zu…');
  try {
    const { matchNeedLines, compactCatalog } = await lazyAi();
    const res = await matchNeedLines({ apiKey: setting('apiKey', ''), lines: open, catalog: compactCatalog(S.products) });
    const by = Object.fromEntries(res.map((m) => [m.line_id, m]));
    let hits = 0;
    const lines = n.lines.map((l) => {
      const m = by[l.id];
      if (!l.code && m && m.code && S.products[m.code] && m.confidence !== 'low') { hits++; return { ...l, code: master(m.code).ean, by: 'claude', reason: m.reason }; }
      return l;
    });
    await saveNeed({ ...S.needs[n.id], lines });
    renderNeeds();
    toast(hits ? `${plural(hits, 'Position', 'Positionen')} zugeordnet` : 'Nichts Passendes im Lager gefunden – kommt auf die Bestellliste.');
  } catch (e) { toast(e.message); }
}

async function takeOutAvailable(n) {
  const rows = computeNeed(n.lines || [], S.products, takenForNeed(n.id, S.jobs)).filter((r) => r.fromStock > 0);
  if (!rows.length) { toast('Für diese Liste ist nichts im Lager.'); return; }
  let job = Object.values(S.jobs).find((j) => j.needId === n.id && !j.closed);
  if (!job) {
    job = { id: store.newId(), name: n.name, createdAt: Date.now(), closed: false, items: {}, needId: n.id };
    S.jobs[job.id] = job; await store.putJob(job); changed();
  }
  S.mode = 'out'; S.jobId = job.id;
  S.basket = rows.reduce((acc, r) => basketAdd(acc, r.product.ean, r.fromStock), []);
  S.shortOk = false;
  await saveSession();
  renderAll(); showView('scan');
  toast('Vorhandenes liegt im Korb. Prüfen und „Entnehmen“ tippen.');
}

function orderText(list) {
  return list.map((o) => `${o.qty} × ${o.name}${o.maker ? ' – ' + o.maker : ''}${o.model ? ' ' + o.model : ''}${o.code && !isTag(o.code) ? ' (EAN ' + o.code + ')' : ''}`).join('\n');
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Kopiert'); }
  catch { openSheet(`<div class="top"><h2>Bestellliste</h2><button class="small" data-act="close">Schließen</button></div><textarea rows="12" readonly>${esc(text)}</textarea>`, (a) => { if (a === 'close') closeSheet(); }); }
}

// ---------- Excel ----------
async function excelBytes() {
  const { buildWorkbook, workbookBytes } = await lazyExcel();
  return workbookBytes(await buildWorkbook(await store.exportAll()));
}
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function markSaved() {
  S.dirty = 0; S.savedAt = Date.now();
  await setSetting('dirty', 0); await setSetting('lastExport', S.savedAt);
  renderExcelState();
}

async function saveExcel({ quiet = false } = {}) {
  try {
    const bytes = await excelBytes();
    if (ARTIFACT) {
      const dl = await window.claude?.use?.('downloads');
      if (!dl) throw new Error('Speichern ist in dieser Ansicht nicht möglich.');
      try { await dl.save({ filename: `lager-${today()}.xlsx`, data: new Blob([bytes], { type: XLSX_TYPE }) }); }
      catch (e) { if (e?.code === 'declined') return; throw new Error(e?.message || e?.code); }
      await markSaved();
      toast('Excel-Datei gespeichert');
      return;
    }
    if (S.fileHandle && S.fileOk) {
      const w = await S.fileHandle.createWritable();
      await w.write(new Blob([bytes], { type: XLSX_TYPE }));
      await w.close();
      await markSaved();
      if (!quiet) toast('Excel-Datei aktualisiert');
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: XLSX_TYPE }));
    a.download = `lager-${today()}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    await markSaved();
    toast('Excel-Datei gespeichert');
  } catch (e) {
    if (S.fileHandle) S.fileOk = false;
    renderExcelState();
    toast('Excel speichern fehlgeschlagen: ' + e.message);
  }
}

async function shareExcel() {
  try {
    const file = new File([await excelBytes()], `lager-${today()}.xlsx`, { type: XLSX_TYPE });
    if (!navigator.canShare?.({ files: [file] })) { await saveExcel(); return; }
    await navigator.share({ files: [file], title: 'Lagerbestand' });
    await markSaved();
  } catch (e) { if (e.name !== 'AbortError') toast('Teilen fehlgeschlagen: ' + e.message); }
}

async function linkExcelFile() {
  try {
    const h = await window.showSaveFilePicker({ suggestedName: 'lager.xlsx', types: [{ description: 'Excel', accept: { [XLSX_TYPE]: ['.xlsx'] } }] });
    S.fileHandle = h; S.fileOk = true;
    await setSetting('fileHandle', h);
    await saveExcel();
    renderExcelState();
  } catch (e) { if (e.name !== 'AbortError') toast('Datei verknüpfen fehlgeschlagen: ' + e.message); }
}

async function regrantFile() {
  try {
    S.fileOk = (await S.fileHandle.requestPermission({ mode: 'readwrite' })) === 'granted';
    if (S.fileOk) await saveExcel({ quiet: true });
    renderExcelState();
  } catch (e) { toast(e.message); }
}

async function importExcel(file) {
  try {
    const { parseWorkbook } = await lazyExcel();
    const data = await parseWorkbook(new Uint8Array(await file.arrayBuffer()));
    openSheet(`
      <div class="top"><h2>Excel laden</h2><button class="small" data-act="close">Abbrechen</button></div>
      <p>Ersetzt alles in der App durch die Datei: <b>${data.products.length}</b> Produkte, <b>${data.log.length}</b> Buchungen, <b>${data.jobs.length}</b> Aufträge, <b>${data.needs.length}</b> Bedarfslisten.</p>
      <p class="muted">Änderungen, die du in Excel gemacht hast (z.B. Bestand oder Namen), werden übernommen.</p>
      <button class="primary big" data-act="do-import">Durch Datei ersetzen</button>`, async (act) => {
      if (act === 'close') closeSheet();
      if (act === 'do-import') {
        await store.importAll(data);
        const all = await store.loadAll();
        S.products = all.products; S.jobs = all.jobs; S.needs = all.needs; S.basket = []; S.needId = null;
        await saveSession(); await refreshLogs(); await markSaved();
        closeSheet(); renderAll(); toast('Daten aus Excel geladen');
      }
    });
  } catch (e) { toast(e.message); }
}

// ---------- rendering ----------
function renderMode() {
  $('modeIn').setAttribute('aria-pressed', String(S.mode === 'in'));
  $('modeOut').setAttribute('aria-pressed', String(S.mode === 'out'));
  $('jobPick').hidden = S.mode !== 'out';
}

function renderBasket(showShort = false) {
  const lines = S.basket;
  const out = S.mode === 'out';
  const short = out ? shortages(lines, S.products) : [];
  const shortSet = new Set(short.map((s) => s.ean));
  const total = basketTotal(lines);
  $('basketTitle').textContent = lines.length ? `${out ? 'Entnehmen' : 'Einbuchen'} · ${total} Stück` : 'Korb';
  $('basketList').innerHTML = lines.length
    ? lines.map((l) => {
      const p = master(l.ean);
      const have = p?.qty || 0;
      const sub = out
        ? (shortSet.has(l.ean) ? `<span class="s short">Nur ${have} im Lager</span>` : `<span class="s">${have} im Lager → ${have - l.qty} übrig</span>`)
        : `<span class="s">${have} im Lager → ${have + l.qty}</span>`;
      return `<div class="line" data-ean="${esc(l.ean)}">
        <span class="t">${esc(p?.name || 'Neues Produkt')} ${p && needsAttention(p) ? statusPill(p) : ''}</span>
        <div class="qtybox">
          <button class="small" data-act="minus" aria-label="Eins weniger">−</button>
          <input type="number" inputmode="numeric" min="0" value="${l.qty}" data-act="qty" aria-label="Anzahl" id="q-${esc(l.ean)}">
          <button class="small" data-act="plus" aria-label="Eins mehr">+</button>
        </div>
        ${sub}
      </div>`;
    }).join('')
    : `<div class="empty">${out ? 'Produkt scannen, Anzahl eingeben (z.B. 24 Lampen) – dann alles zusammen entnehmen.' : 'Produkt scannen, Anzahl eingeben – dann alles zusammen einbuchen.'}</div>`;
  $('basketClear').hidden = !lines.length;
  const btn = $('basketBook');
  btn.disabled = !lines.length;
  btn.textContent = lines.length ? (out ? `${total} entnehmen für ${S.jobs[S.jobId]?.name || '…'}` : `${total} einbuchen`) : 'Buchen';
  $('basketWarn').innerHTML = showShort && short.length
    ? `<div class="msg err">Für ${plural(short.length, 'Produkt', 'Produkte')} reicht der Bestand nicht. Der Bestand würde unter null fallen.
        <div class="row" style="margin-top:8px"><button class="small" data-act="short-ok">Trotzdem entnehmen</button></div></div>`
    : '';
}

function entryRow(e) {
  const label = { in: 'Eingang', out: 'Entnahme', undo: 'Storno', adjust: 'Korrektur', merge: 'Zusammengeführt' }[e.k] || e.k;
  const cls = { in: 'in', out: 'out' }[e.k] || '';
  const job = e.j && S.jobs[e.j] ? ' · ' + S.jobs[e.j].name : '';
  const q = e.q > 0 ? '+' + e.q : e.q < 0 ? '−' + Math.abs(e.q) : '0';
  const canUndo = ['in', 'out', 'adjust'].includes(e.k) && !e.undone;
  return `<div class="item ${e.undone ? 'undone' : ''}">
    <span class="t">${esc(pname(e.e))}</span>
    <span class="n">${q}</span>
    <span class="s"><span class="pill ${cls}">${label}</span> ${fmtTime(e.t)} · <span class="mono">${esc(e.e)}</span>${esc(job)}${e.from ? ' · von ' + esc(e.from) : ''}
    ${canUndo ? ` · <button class="small ghost" data-act="undo" data-id="${esc(e.id)}">Stornieren</button>` : ''}</span>
  </div>`;
}
function renderRecent() { $('recent').innerHTML = S.recent.length ? S.recent.map(entryRow).join('') : '<div class="empty">Noch keine Buchungen.</div>'; }

function productRow(p) {
  return `<button class="item" data-act="product" data-ean="${esc(p.ean)}">
    <span class="t">${esc(p.name || 'Unbenanntes Produkt')} ${needsAttention(p) ? statusPill(p) : ''}</span>
    <span class="n ${(p.qty || 0) > 0 ? '' : 'zero'}">${p.qty || 0}${unitOf(p) ? '<small> m</small>' : ''}</span>
    <span class="s">${esc(subline(p))}${subline(p) ? ' · ' : ''}<span class="mono">${esc(p.ean)}</span>${(p.aliases || []).length ? ` +${p.aliases.length}` : ''}</span>
  </button>`;
}

function renderStock() {
  const all = Object.values(S.products).filter((p) => !p.aliasOf);
  const items = all.reduce((s, p) => s + Math.max(0, p.qty || 0), 0);
  $('stockSummary').innerHTML = `<div><span class="label">Produkte</span><b>${all.length}</b></div><div><span class="label">Stück</span><b>${items}</b></div><div><span class="label">Zu prüfen</span><b>${all.filter(needsAttention).length}</b></div>`;
  const q = $('stockSearch').value.trim().toLowerCase();
  let list = all;
  if (q) list = list.filter((p) => [p.name, p.maker, p.series, p.category, p.variant, p.color, p.model, p.ean, ...(p.aliases || [])].join(' ').toLowerCase().includes(q));
  if ($('onlyInStock').checked) list = list.filter((p) => (p.qty || 0) > 0);
  if ($('onlyOpen').checked) list = list.filter(needsAttention);
  list.sort((a, b) => cmpText(a.maker, b.maker) || cmpText(a.series, b.series) || cmpText(a.name, b.name));
  const groups = groupByCategory(list);
  $('stockList').innerHTML = list.length
    ? groups.map((g) => `<div class="group"><div class="day top"><span class="label">${esc(g.category)}</span><span class="label">${plural(g.items.length, 'Produkt', 'Produkte')} · ${g.qty} Stück</span></div>
        ${g.items.slice(0, 300).map(productRow).join('')}</div>`).join('')
    : `<div class="empty">${all.length ? 'Nichts gefunden.' : 'Noch keine Produkte. Jeder neue Barcode, den du scannst, landet hier.'}</div>`;
}

function renderJobs() {
  const jobs = Object.values(S.jobs).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const row = (j) => {
    const n = Object.values(j.items || {}).reduce((s, x) => s + x, 0);
    const kinds = Object.keys(j.items || {}).length;
    return `<button class="item" data-act="job" data-id="${esc(j.id)}"><span class="t">${esc(j.name)}</span><span class="n ${n ? '' : 'zero'}">${n}</span>
      <span class="s">${plural(kinds, 'Produkt', 'Produkte')} · seit ${fmtDate(j.createdAt)}</span></button>`;
  };
  const open = jobs.filter((j) => !j.closed);
  const closed = jobs.filter((j) => j.closed);
  $('jobsOpen').innerHTML = open.length ? open.map(row).join('') : '<div class="empty">Keine offenen Aufträge. Oben einen anlegen.</div>';
  $('jobsClosed').innerHTML = closed.length ? closed.map(row).join('') : '<div class="empty">Abgeschlossene Aufträge erscheinen hier.</div>';
  const sel = $('jobSelect');
  sel.innerHTML = (open.length ? '<option value="">Auftrag wählen…</option>' : '<option value="">Noch kein offener Auftrag</option>') + open.map((j) => `<option value="${esc(j.id)}">${esc(j.name)}</option>`).join('');
  sel.value = S.jobs[S.jobId] && !S.jobs[S.jobId].closed ? S.jobId : '';
}

function needSummary(n) {
  const rows = computeNeed(n.lines || [], S.products, takenForNeed(n.id, S.jobs));
  const full = rows.filter((r) => !r.missing).length;
  const missing = rows.filter((r) => r.missing);
  return { rows, full, missingLines: missing.length, missingQty: missing.reduce((s, r) => s + r.missing, 0) };
}

function renderNeeds() {
  const n = S.needId && S.needs[S.needId];
  $('needsList').hidden = !!n;
  $('needDetail').hidden = !n;
  if (!n) {
    const lists = Object.values(S.needs).sort((a, b) => (a.closed - b.closed) || (b.created || 0) - (a.created || 0));
    $('needsItems').innerHTML = lists.length ? lists.map((x) => {
      const s = needSummary(x);
      const pill = x.closed ? '<span class="pill">Erledigt</span>' : !x.lines?.length ? '<span class="pill">Leer</span>' : s.missingLines ? `<span class="pill bad">${s.missingQty} fehlen</span>` : '<span class="pill ok">Alles da</span>';
      return `<button class="item" data-act="need" data-id="${esc(x.id)}"><span class="t">${esc(x.name)} ${pill}</span><span class="n">${(x.lines || []).length}</span>
        <span class="s">${plural((x.lines || []).length, 'Position', 'Positionen')} · ${s.full} komplett da · seit ${fmtDate(x.created)}</span></button>`;
    }).join('') : '<div class="empty">Noch keine Bedarfsliste. Oben einen Namen eingeben, z.B. „Halle 2 Elektro“.</div>';
    const ord = orderList(Object.values(S.needs), S.products, S.jobs);
    $('orderAll').innerHTML = ord.length
      ? `<div class="top"><h2>Bestellliste</h2><button class="small" data-act="copy-order-all">Kopieren</button></div>
         <div class="list">${ord.map((o) => `<div class="item"><span class="t">${esc(o.name)}</span><span class="n">${o.qty}</span><span class="s">${esc([o.maker, o.model].filter(Boolean).join(' · '))}${o.maker || o.model ? ' · ' : ''}für ${esc(o.needs.join(', '))}</span></div>`).join('')}</div>`
      : '';
    return;
  }
  const s = needSummary(n);
  $('needTitle').textContent = n.name;
  $('needStats').innerHTML = (n.lines || []).length
    ? `<div><span class="label">Positionen</span><b>${n.lines.length}</b></div><div><span class="label">Komplett da</span><b>${s.full}</b></div><div><span class="label">Fehlt (Stück)</span><b class="${s.missingQty ? 'bad-text' : ''}">${s.missingQty}</b></div>`
    : '';
  $('needLines').innerHTML = s.rows.length ? s.rows.map((r) => `
    <div class="line need" data-line="${esc(r.id)}">
      <span class="t">${esc(r.text)}</span>
      <div class="qtybox"><input type="number" inputmode="numeric" min="1" value="${r.qty}" data-act="need-qty" aria-label="Benötigt" id="nq-${esc(r.id)}"></div>
      <span class="s">${r.product
        ? `→ ${esc(r.product.name || r.product.ean)} · ${r.taken ? `<b>${r.taken}</b> entnommen · ` : ''}<b>${r.fromStock}</b> im Lager${r.missing ? ` · <span class="short">${r.missing} fehlen</span>` : ' · <span class="okc">komplett</span>'}`
        : `<span class="short">Nicht im Lager · ${r.qty} bestellen</span>`}
        · <button class="small ghost" data-act="need-assign" data-line="${esc(r.id)}">${r.product ? 'Ändern' : 'Zuordnen'}</button>
        <button class="small ghost danger" data-act="need-del" data-line="${esc(r.id)}" aria-label="Position löschen">✕</button></span>
    </div>`).join('') : '<div class="empty">Positionen eingeben, z.B. „20 Steckdosen“, „8 Rahmen 2-fach Busch-Jaeger“, „12 Rahmen 1-fach“.</div>';
  const hasKey = aiOn();
  const unassigned = (n.lines || []).filter((l) => !l.code).length;
  $('needActions').innerHTML = `
    ${hasKey && unassigned ? `<button data-act="need-claude">Mit Claude zuordnen (${unassigned})</button>` : ''}
    ${s.rows.some((r) => r.fromStock) && !n.closed ? '<button class="primary" data-act="need-take">Vorhandenes entnehmen</button>' : ''}
    <button data-act="need-close">${n.closed ? 'Wieder öffnen' : 'Als erledigt markieren'}</button>
    <button class="ghost danger" data-act="need-delete">Liste löschen</button>`;
  const ord = orderList([{ ...n, closed: false }], S.products, S.jobs);
  $('needOrder').innerHTML = ord.length
    ? `<div class="top"><h2>Muss bestellt werden</h2><button class="small" data-act="copy-order">Kopieren</button></div>
       <div class="list">${ord.map((o) => `<div class="item"><span class="t">${esc(o.name)}</span><span class="n">${o.qty}</span><span class="s">${esc([o.maker, o.model].filter(Boolean).join(' · ') || (o.code ? 'Code ' + o.code : 'Nicht im Lager'))}</span></div>`).join('')}</div>`
    : (n.lines || []).length ? '<div class="msg ok">Alles da – nichts zu bestellen.</div>' : '';
}

function renderReview() {
  const st = checkStats();
  const key = aiOn();
  const last = setting('lastCheck', null);
  const batch = setting('batchSize', DEFAULT_BATCH);
  $('checkPanel').innerHTML = `
    <div class="top"><h2>Recherche durch Claude</h2>${S.checking ? '<span class="pill warn">Recherchiert…</span>' : ''}</div>
    <div>${st.reading ? `${st.reading} Etikett(en) werden gelesen · ` : ''}<b>${st.waiting}</b> warten${st.failed ? ` · <b>${st.failed}</b> unlesbar` : ''}. ${ARTIFACT
      ? `Claude Haiku erkennt neue Produkte am Etikett-Foto, sobald ${batch === 1 ? 'ein Produkt wartet' : batch + ' Produkte warten'}. Läuft über dein Claude-Abo.`
      : `Claude Haiku recherchiert neue Produkte im Internet, sobald ${batch === 1 ? 'ein Produkt' : batch + ' Produkte'} warten, oder sofort, wenn ein Etikett unlesbar ist.`}</div>
    ${key ? '' : ARTIFACT
      ? '<div class="msg info">Claude ist gerade nicht verfügbar. Beim ersten Mal fragt claude.ai, ob die App Claude nutzen darf – bitte erlauben. Ohne Claude trägst du die Angaben selbst ein.</div>'
      : '<div class="msg info">In den Einstellungen deinen Anthropic-API-Schlüssel eintragen, dann recherchiert Claude Haiku neue Produkte automatisch. Ohne Schlüssel trägst du die Angaben selbst ein.</div>'}
    ${last ? `<div class="muted">Letzte Recherche ${new Date(last.t).toLocaleString('de-DE')}: ${last.error ? `<span class="bad-text">${esc(last.error)}</span>` : `${plural(last.n, 'Produkt', 'Produkte')}${last.searches ? `, ${last.searches} Websuchen` : ''}`}</div>` : ''}
    <div class="row"><button data-act="check-now" ${!key || S.checking || !(st.waiting + st.failed) ? 'disabled' : ''}>Jetzt recherchieren</button>${key || ARTIFACT ? '' : '<button data-act="settings">Einstellungen</button>'}</div>`;
  const dupes = setting('dupes', []).filter((d) => S.products[d.a] && S.products[d.b] && !S.products[d.a].aliasOf && !S.products[d.b].aliasOf);
  $('dupes').innerHTML = dupes.length ? '<div class="label">Vielleicht dasselbe Produkt</div>' + dupes.map((d) => {
    const A = S.products[d.a], B = S.products[d.b];
    const card = (p) => `<div><b>${esc(p.name || 'Unbenannt')}</b><br><span class="muted">${esc(subline(p))}</span><br><span class="mono">${esc(p.ean)}</span> · ${p.qty || 0} im Lager</div>`;
    return `<div class="panel dupe"><div class="pair">${card(A)}${card(B)}</div>${d.reason ? `<span class="muted">${esc(d.reason)}</span>` : ''}
      <div class="row" style="flex-wrap:wrap"><button class="small" data-act="merge-dupe" data-from="${esc(d.b)}" data-into="${esc(d.a)}">Links behalten, rechts zusammenführen</button>
      <button class="small" data-act="merge-dupe" data-from="${esc(d.a)}" data-into="${esc(d.b)}">Rechts behalten</button>
      <button class="small ghost" data-act="dismiss-dupe" data-a="${esc(d.a)}" data-b="${esc(d.b)}">Nicht dasselbe</button></div></div>`;
  }).join('') : '';
  const open = Object.values(S.products).filter(needsAttention).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  $('openList').innerHTML = open.length ? open.map((p) => `<button class="item" data-act="product" data-ean="${esc(p.ean)}">
      <span class="t">${esc(p.name || 'Unbenanntes Produkt')} ${statusPill(p)}</span><span class="n">${p.qty || 0}</span>
      <span class="s"><span class="mono">${esc(p.ean)}</span>${p.aiNote ? ' · ' + esc(p.aiNote) : ''}</span></button>`).join('')
    : '<div class="empty">Alle Produkte sind geprüft.</div>';
  const nAtt = Object.values(S.products).filter((p) => !p.aliasOf && ['error', 'manual'].includes(p.status)).length + dupes.length;
  $('reviewBadge').hidden = !nAtt; $('reviewBadge').textContent = nAtt;
  const chip = $('checkChip');
  chip.hidden = !(st.waiting || st.reading || S.checking);
  chip.textContent = S.checking ? 'Claude recherchiert…' : st.reading ? `Liest ${st.reading} Etikett${st.reading === 1 ? '' : 'en'}…` : `${st.waiting}/${batch} warten auf Recherche`;
}

function renderLog() {
  let html = '', lastDay = '';
  for (const e of S.logItems) {
    const d = new Date(e.t).toDateString();
    if (d !== lastDay) { html += `<div class="day label">${esc(new Date(e.t).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}</div>`; lastDay = d; }
    html += entryRow(e);
  }
  $('logList').innerHTML = html || '<div class="empty">Noch keine Buchungen.</div>';
  $('logMore').hidden = S.logDone;
}

function renderExcelState() {
  const dot = $('excelDot');
  const linked = !!S.fileHandle;
  dot.hidden = !(S.dirty > 0 || (linked && !S.fileOk));
  const b = $('banner');
  if (linked && !S.fileOk) {
    b.hidden = false; b.className = 'banner bad';
    b.innerHTML = '<span>Die verknüpfte Excel-Datei braucht wieder Zugriff.</span><button class="small" data-act="regrant">Zugriff erlauben</button>';
  } else if (!linked && S.dirty >= 25) {
    b.hidden = false; b.className = 'banner';
    b.innerHTML = `<span>${S.dirty} Änderungen sind noch nicht in der Excel-Datei.</span><button class="small" data-act="excel-save">Excel speichern</button>`;
  } else b.hidden = true;
  const st = $('excelState');
  if (st) st.innerHTML = linked
    ? (S.fileOk ? `Verknüpft mit <b>${esc(S.fileHandle.name)}</b>. Jede Änderung wird automatisch gespeichert${S.savedAt ? ` (zuletzt ${fmtTime(S.savedAt)})` : ''}.` : 'Verknüpfte Datei braucht wieder Zugriff.')
    : (S.dirty ? `<b>${S.dirty}</b> Änderungen seit dem letzten Speichern.` : `Excel ist auf dem neuesten Stand${S.savedAt ? ` (${new Date(S.savedAt).toLocaleString('de-DE')})` : ''}.`);
}

function renderAll() {
  renderMode(); renderBasket(); renderRecent(); renderStock(); renderJobs(); renderNeeds(); renderReview(); renderLog(); renderExcelState();
}

function showView(v) {
  S.view = v;
  for (const n of ['scan', 'stock', 'needs', 'jobs', 'log', 'review']) $('view-' + n).hidden = n !== v;
  document.querySelectorAll('.tabs button').forEach((b) => (b.dataset.view === v ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  if (v !== 'scan' && S.camera) stopCamera();
  window.scrollTo(0, 0);
}

// ---------- sheets ----------
let sheetHandler = null;
function openSheet(html, onAct) {
  $('sheetRoot').innerHTML = `<div class="sheet-back"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  sheetHandler = onAct;
}
function closeSheet() { $('sheetRoot').innerHTML = ''; sheetHandler = null; }

async function productSheet(code) {
  const p = S.products[code];
  if (!p) return;
  const img = p.hasImage ? await store.getImage(code) : null;
  const imgUrl = img ? URL.createObjectURL(img) : '';
  const hist = await store.logForProduct(code, 20);
  const jobsUsing = Object.values(S.jobs).filter((j) => j.items?.[code]);
  const qr = isTag(code) ? await (await lazyQr()).toDataURL(code, { margin: 1, width: 240 }) : '';
  const v = (k) => esc(p[k] || '');
  openSheet(`
    <div class="top"><h2>${esc(p.name || 'Unbenanntes Produkt')}</h2><button class="small" data-act="close">Schließen</button></div>
    <div><span class="mono">${esc(code)}</span> ${statusPill(p)}${isTag(code) ? ' <span class="pill">Eigener Code</span>' : ''}${(p.aliases || []).length ? `<br><span class="muted">Auch gescannt als: ${p.aliases.map(esc).join(', ')}</span>` : ''}</div>
    ${p.aiNote ? `<div class="msg info">${esc(p.aiNote)}</div>` : ''}
    <div class="panel">
      <input id="pf-name" placeholder="Produktname" aria-label="Produktname" value="${v('name')}">
      <div class="row"><select id="pf-cat" class="grow" aria-label="Kategorie">${catOptions(p.category)}</select><input id="pf-variant" class="grow" placeholder="Variante" aria-label="Variante" value="${v('variant')}"></div>
      <div class="row"><input id="pf-maker" class="grow" placeholder="Hersteller" aria-label="Hersteller" value="${v('maker')}"><input id="pf-series" class="grow" placeholder="Serie" aria-label="Serie" value="${v('series')}"></div>
      <div class="row"><input id="pf-model" class="grow" placeholder="Artikelnr." aria-label="Artikelnummer" value="${v('model')}"><input id="pf-color" class="grow" placeholder="Farbe" aria-label="Farbe" value="${v('color')}"></div>
      <input id="pf-desc" placeholder="Beschreibung" aria-label="Beschreibung" value="${v('description')}">
      <div class="row"><input id="pf-order" class="grow" placeholder="Bestellnr. (z.B. 2CKA…)" aria-label="Bestellnummer" value="${v('orderNo')}"><select id="pf-unit" class="grow" aria-label="Einheit">${['Stück', 'm'].map((x) => `<option ${(unitOf(p) || 'Stück') === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
      <label class="label" for="pf-ids">Alle Nummern (für spätere Preisrecherche)</label>
      <input id="pf-ids" aria-label="Alle Nummern" value="${esc(mergeIds(p.ean, p.model, p.orderNo, p.ids))}">
      <div class="row"><label class="label" for="pf-price" style="flex:0 0 auto">Einzelpreis €</label><input id="pf-price" class="grow" type="number" inputmode="decimal" step="0.01" min="0" placeholder="später" value="${p.price ?? ''}"></div>
      <div class="row"><button class="primary grow" data-act="save">Speichern</button>${aiOn() ? '<button class="grow" data-act="research">Neu recherchieren</button>' : ''}</div>
      ${p.source ? `<span class="muted">Quelle: <a href="${esc(p.source)}" target="_blank" rel="noopener">${esc(p.source.slice(0, 60))}</a></span>` : ''}
    </div>
    ${qr ? `<div class="panel label-card"><img src="${qr}" alt="QR-Code ${esc(code)}" width="160" height="160"><div><b>Etikett für Produkte ohne Barcode</b><br><span class="muted">Ausdrucken und aufkleben – dann scannt die Kamera diesen Code wie einen Barcode.</span><br><button class="small" data-act="print-label">${ARTIFACT ? 'Etikett als Bild speichern' : 'Etikett drucken'}</button></div></div>` : ''}
    ${imgUrl ? `<img class="thumb" src="${imgUrl}" alt="Foto">` : ''}
    ${p.ocrText ? `<details><summary class="muted">Vom Etikett gelesener Text</summary><pre>${esc(p.ocrText)}</pre></details>` : ''}
    <div class="panel">
      <label class="label" for="pf-qty">Bestand korrigieren (Inventur)</label>
      <div class="row"><input id="pf-qty" class="grow" type="number" inputmode="numeric" value="${p.qty || 0}"><button data-act="adjust">Bestand setzen</button></div>
    </div>
    <div class="panel">
      <label class="label" for="pf-merge">Ist das dasselbe Produkt wie ein anderes?</label>
      <input id="pf-merge" placeholder="Anderes Produkt suchen" autocomplete="off">
      <div id="pf-merge-list" class="list" hidden></div>
      <span class="muted">Zusammenführen schiebt den Bestand zum anderen Produkt. Beide Codes buchen danach dasselbe Produkt.</span>
    </div>
    ${jobsUsing.length ? `<div class="label">Entnommen für</div><div class="list">${jobsUsing.map((j) => `<div class="item"><span class="t">${esc(j.name)}</span><span class="n">${j.items[code]}</span></div>`).join('')}</div>` : ''}
    <div class="label">Verlauf</div>
    <div class="list">${hist.length ? hist.map(entryRow).join('') : '<div class="empty">Noch keine Buchungen.</div>'}</div>
  `, async (act, el) => {
    const cleanup = () => { if (imgUrl) URL.revokeObjectURL(imgUrl); };
    if (act === 'close') { closeSheet(); cleanup(); }
    if (act === 'save' || act === 'research') {
      const val = (id) => $(id).value.trim();
      const np = {
        ...S.products[code], name: val('pf-name'), category: val('pf-cat'), variant: val('pf-variant'), maker: val('pf-maker'),
        series: val('pf-series'), model: val('pf-model'), color: val('pf-color'), description: val('pf-desc'), updated: Date.now(),
        orderNo: val('pf-order'), ids: mergeIds(val('pf-ids')), unit: val('pf-unit') === 'm' ? 'm' : 'Stück',
        price: val('pf-price') === '' ? null : Math.round(parseFloat(val('pf-price').replace(',', '.')) * 100) / 100,
        ...(act === 'save' ? { status: 'edited', aiNote: '' } : { status: 'ocr', checkTries: 0, aiNote: '' }),
      };
      S.products[code] = np; await store.putProduct(np);
      if (act === 'save' && np.hasImage && !isTag(code)) { await store.deleteImage(code); np.hasImage = false; await store.putProduct(np); }
      changed(); closeSheet(); cleanup(); renderAll();
      if (act === 'research') { toast('Claude recherchiert…'); maybeRunCheck(true); } else toast('Gespeichert');
    }
    if (act === 'print-label') printLabel(S.products[code], qr);
    if (act === 'adjust') {
      const n = parseInt($('pf-qty').value, 10);
      if (!Number.isFinite(n)) return;
      const r = await store.adjustCount(code, n);
      S.products[code] = r.product; changed(); await refreshLogs(); closeSheet(); cleanup(); renderAll(); toast('Bestand auf ' + n + ' gesetzt');
    }
    if (act === 'merge-pick') {
      const into = el.dataset.ean;
      $('pf-merge-list').innerHTML = `<div class="item"><span class="t">Mit „${esc(S.products[into].name || into)}“ zusammenführen? ${p.qty || 0} Stück wandern rüber.</span>
        <span class="s"><button class="small primary" data-act="merge-confirm" data-ean="${esc(into)}">Zusammenführen</button> <button class="small" data-act="close">Abbrechen</button></span></div>`;
    }
    if (act === 'merge-confirm') { closeSheet(); cleanup(); await merge(code, el.dataset.ean); }
    if (act === 'undo') { closeSheet(); cleanup(); await undo(el.dataset.id); }
  });
  $('pf-merge').addEventListener('input', (ev) => {
    const q = ev.target.value.trim().toLowerCase();
    const box = $('pf-merge-list');
    if (q.length < 2) { box.hidden = true; return; }
    const hits = Object.values(S.products).filter((x) => x.ean !== code && !x.aliasOf && [x.name, x.maker, x.model, x.ean].join(' ').toLowerCase().includes(q)).slice(0, 8);
    box.hidden = false;
    box.innerHTML = hits.length ? hits.map((x) => `<button class="item" data-act="merge-pick" data-ean="${esc(x.ean)}"><span class="t">${esc(x.name || 'Unbenannt')}</span><span class="n">${x.qty || 0}</span><span class="s mono">${esc(x.ean)}</span></button>`).join('') : '<div class="empty">Nichts gefunden.</div>';
  });
}

async function saveLabelPng(p, qr) {
  const img = new Image();
  img.src = qr;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = 720; c.height = 260;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 20, 20, 220, 220);
  g.fillStyle = '#000'; g.font = 'bold 28px Arial';
  const words = String(p.name || '').split(' ');
  let line = '', y = 60;
  for (const w of words) { if (g.measureText(line + w).width > 440) { g.fillText(line, 260, y); y += 34; line = ''; } line += w + ' '; }
  g.fillText(line, 260, y);
  g.font = '24px Arial'; g.fillText([p.maker, p.model].filter(Boolean).join(' '), 260, y + 40);
  g.font = '24px monospace'; g.fillText(p.ean, 260, 225);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const dl = await window.claude?.use?.('downloads');
  try { await dl?.save({ filename: `etikett-${p.ean}.png`, data: blob }); } catch (e) { if (e?.code !== 'declined') toast('Etikett speichern fehlgeschlagen.'); }
}

function printLabel(p, qr) {
  if (ARTIFACT) { saveLabelPng(p, qr); return; }
  const w = window.open('', '_blank', 'width=420,height=360');
  if (!w) { toast('Pop-up blockiert. Bitte Pop-ups für diese Seite erlauben.'); return; }
  w.document.write(`<!doctype html><title>Etikett ${esc(p.ean)}</title><style>body{font:14px Arial,sans-serif;margin:12px}.l{display:flex;gap:10px;align-items:center;border:1px dashed #999;padding:8px;width:300px}b{display:block;font-size:15px}</style>
    <div class="l"><img src="${qr}" width="110" height="110"><div><b>${esc(p.name || '')}</b>${esc([p.maker, p.model].filter(Boolean).join(' '))}<br><code>${esc(p.ean)}</code></div></div><script>onload=()=>{print()}<\/script>`);
  w.document.close();
}

function jobSheet(id) {
  const j = S.jobs[id];
  const items = Object.entries(j.items || {}).sort((a, b) => pname(a[0]).localeCompare(pname(b[0])));
  openSheet(`
    <div class="top"><h2>${esc(j.name)}</h2><button class="small" data-act="close">Schließen</button></div>
    <span class="muted">${j.closed ? 'Abgeschlossen' : 'Offen'} · seit ${fmtDate(j.createdAt)}</span>
    <div class="list">${items.length ? items.map(([e, n]) => `<div class="item"><span class="t">${esc(pname(e))}</span><span class="n">${n}</span><span class="s"><span class="mono">${esc(e)}</span> · noch ${master(e)?.qty ?? 0} im Lager</span></div>`).join('') : '<div class="empty">Für diesen Auftrag wurde noch nichts entnommen.</div>'}</div>
    <div class="row" style="flex-wrap:wrap">${j.closed ? '<button data-act="reopen">Wieder öffnen</button>' : '<button class="primary" data-act="use">Für diesen Auftrag entnehmen</button><button data-act="close-job">Abschließen</button>'}</div>
  `, async (act) => {
    if (act === 'close') closeSheet();
    if (act === 'use') { S.mode = 'out'; S.jobId = id; await saveSession(); closeSheet(); renderAll(); showView('scan'); }
    if (act === 'close-job' || act === 'reopen') {
      const nj = { ...j, closed: act === 'close-job' };
      S.jobs[id] = nj; await store.putJob(nj); changed();
      if (nj.closed && S.jobId === id) { S.jobId = ''; await saveSession(); }
      closeSheet(); renderAll();
    }
  });
}

function assignSheet(needId, lid) {
  const n = S.needs[needId];
  const line = n.lines.find((l) => l.id === lid);
  const list = (q) => {
    const sug = q ? suggestProducts(q, S.products, 12).map((s) => s.p) : [];
    const extra = q ? Object.values(S.products).filter((p) => !p.aliasOf && !sug.includes(p) && [p.name, p.maker, p.model, p.ean].join(' ').toLowerCase().includes(q.toLowerCase())).slice(0, 8) : [];
    const all = [...sug, ...extra];
    return all.length ? all.map((p) => `<button class="item" data-act="assign-pick" data-ean="${esc(p.ean)}"><span class="t">${esc(p.name || p.ean)}</span><span class="n">${p.qty || 0}</span><span class="s">${esc(subline(p))}</span></button>`).join('') : '<div class="empty">Nichts Passendes im Lager.</div>';
  };
  openSheet(`
    <div class="top"><h2>Zuordnen</h2><button class="small" data-act="close">Abbrechen</button></div>
    <div><b>${line.qty} × ${esc(line.text)}</b></div>
    <input id="as-q" value="${esc(line.text)}" placeholder="Im Lager suchen" autocomplete="off">
    <div id="as-list" class="list">${list(line.text)}</div>
    <button data-act="assign-none">Nicht im Lager – auf die Bestellliste</button>
  `, async (act, el) => {
    if (act === 'close') closeSheet();
    if (act === 'assign-pick' || act === 'assign-none') {
      const code = act === 'assign-pick' ? el.dataset.ean : null;
      await saveNeed({ ...n, lines: n.lines.map((l) => (l.id === lid ? { ...l, code, by: code ? 'manual' : null } : l)) });
      closeSheet(); renderNeeds();
    }
  });
  $('as-q').addEventListener('input', (e) => { $('as-list').innerHTML = list(e.target.value.trim()); });
}

function excelSheet() {
  const canLink = !ARTIFACT && typeof window.showSaveFilePicker === 'function';
  const canShare = !ARTIFACT && !!navigator.canShare;
  openSheet(`
    <div class="top"><h2>Excel</h2><button class="small" data-act="close">Schließen</button></div>
    <div class="msg info" id="excelState"></div>
    <span class="muted">Die Excel-Datei ist dein Lagerbuch: Übersicht, Bestand (nach Kategorien), Bedarf, Bestellliste, Buchungen und Aufträge – formatiert und filterbar.</span>
    ${canLink ? `<button class="primary" data-act="excel-link">${S.fileHandle ? 'Andere Datei verknüpfen' : 'Excel-Datei verknüpfen (automatisch speichern)'}</button>` : ''}
    <button ${canLink ? '' : 'class="primary"'} data-act="excel-save">${S.fileHandle && S.fileOk ? 'Jetzt speichern' : 'Excel-Datei speichern'}</button>
    ${canShare ? '<button data-act="excel-share">Teilen (OneDrive, Drive, Mail…)</button>' : ''}
    <label class="btn">Excel-Datei laden (ersetzt die Daten)<input type="file" id="excel-import" accept=".xlsx,${XLSX_TYPE}"></label>
    <span class="muted">${ARTIFACT ? 'Die Daten sind in claude.ai gespeichert und auf Handy und PC gleich. Die Excel-Datei ist ein Abzug davon – jederzeit neu speichern.' : canLink ? 'Am PC (Chrome/Edge) wird die verknüpfte Datei nach jeder Änderung automatisch aktualisiert.' : 'Am Handy: „Teilen“ speichert die Datei z.B. in OneDrive oder Google Drive. Am PC mit Chrome oder Edge kann die App eine Datei automatisch aktuell halten.'}</span>
  `, async (act) => {
    if (act === 'close') closeSheet();
    if (act === 'excel-link') await linkExcelFile();
    if (act === 'excel-save') await saveExcel();
    if (act === 'excel-share') await shareExcel();
    renderExcelState();
  });
  $('excel-import').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importExcel(f); });
  renderExcelState();
}

function settingsSheet() {
  const key = setting('apiKey', '');
  openSheet(`
    <div class="top"><h2>Einstellungen</h2><button class="small" data-act="close">Schließen</button></div>
    <div class="panel">
      ${ARTIFACT ? `<div class="label">Claude</div><span class="muted">Claude Haiku läuft über dein Claude-Abo, ohne API-Schlüssel. Status: ${S.ai?.text ? 'verfügbar' : 'nicht verfügbar'}${S.ai?.text && !S.ai.images ? ' (ohne Fotos)' : ''}.</span>` : `
      <label class="label" for="set-key">Anthropic-API-Schlüssel (für Claude Haiku)</label>
      <input id="set-key" type="password" autocomplete="off" placeholder="sk-ant-…" value="${esc(key)}">
      <span class="muted">Bleibt nur auf diesem Gerät und geht nur an Anthropic. Anlegen unter console.anthropic.com → API Keys. Recherche von 10 Produkten kostet etwa 10–20 Cent (Websuche), Erkennen per Foto unter 1 Cent.</span>`}
      <label class="label" for="set-batch">Neue Produkte recherchieren</label>
      <select id="set-batch">${[[1, 'sofort, einzeln'], [5, 'in Paketen von 5'], [10, 'in Paketen von 10'], [20, 'in Paketen von 20']].map(([n, t]) => `<option value="${n}" ${setting('batchSize', DEFAULT_BATCH) === n ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <button class="primary" data-act="save-settings">Speichern</button>
    </div>
    <button data-act="open-excel">Excel speichern / laden</button>
  `, async (act) => {
    if (act === 'close') closeSheet();
    if (act === 'open-excel') excelSheet();
    if (act === 'save-settings') {
      const key = ARTIFACT ? '' : $('set-key').value.trim();
      const batch = Number($('set-batch').value);
      closeSheet(); // before awaiting, so a sheet opened meanwhile stays open
      if (!ARTIFACT) await setSetting('apiKey', key);
      await setSetting('batchSize', batch);
      S.checkRetryAt = 0;
      renderAll(); toast('Gespeichert');
      maybeRunCheck();
    }
  });
}

// ---------- events ----------
function bind() {
  $('modeIn').onclick = async () => { S.mode = 'in'; await saveSession(); renderAll(); };
  $('modeOut').onclick = async () => { S.mode = 'out'; await saveSession(); renderAll(); };
  $('jobSelect').onchange = async (e) => { S.jobId = e.target.value; await saveSession(); renderBasket(); };
  $('jobNewQuick').onclick = () => { showView('jobs'); $('jobName').focus(); };
  $('camStart').onclick = toggleCamera;
  $('camStop').onclick = stopCamera;
  $('scanBtn').addEventListener('click', onScanClick);
  $('scanInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; scanProduct(f); });
  $('codeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const val = $('codeInput').value; $('codeInput').value = '';
    if (!val.trim()) return;
    if (looksLikeText(val)) { identifySheet(null, { text: val.trim() }); return; } // a product name, not a barcode
    await handleCode(val, 'key', null);
    $('codeInput').focus();
  });
  $('basketBook').onclick = bookBasket;
  $('basketClear').onclick = async () => { S.basket = []; await saveSession(); renderBasket(); };
  $('basketList').addEventListener('change', async (e) => {
    if (e.target.dataset.act !== 'qty') return;
    S.basket = basketSet(S.basket, e.target.closest('.line').dataset.ean, e.target.value); S.shortOk = false;
    await saveSession(); renderBasket();
  });
  $('jobForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('jobName').value.trim();
    if (!name) return;
    const j = { id: store.newId(), name: name.slice(0, 120), createdAt: Date.now(), closed: false, items: {} };
    S.jobs[j.id] = j; await store.putJob(j); changed();
    S.jobId = j.id; S.mode = 'out'; await saveSession();
    $('jobName').value = '';
    renderAll(); showView('scan'); toast('Auftrag angelegt. Jetzt die Teile scannen, die du mitnimmst.');
  });
  $('needForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('needName').value.trim();
    if (!name) return;
    const n = { id: store.newId(), name: name.slice(0, 120), created: Date.now(), closed: false, lines: [] };
    await saveNeed(n);
    $('needName').value = '';
    S.needId = n.id; renderNeeds();
    $('needLine').focus();
  });
  $('needLineForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = $('needLine').value.trim();
    if (!raw) return;
    $('needLine').value = ''; $('needSuggest').innerHTML = ''; // clear first so the next line can be typed right away
    await addNeedLine(S.needs[S.needId], raw);
    renderNeeds(); $('needLine').focus();
  });
  $('needLine').addEventListener('input', (e) => {
    const { text } = parseNeedText(e.target.value);
    const sug = text.length >= 3 ? suggestProducts(text, S.products, 3) : [];
    $('needSuggest').innerHTML = sug.map((s) => `<button type="button" class="small" data-act="need-sug" data-ean="${esc(s.code)}">→ ${esc(s.p.name || s.code)} <span class="muted">(${s.p.qty || 0})</span></button>`).join('');
  });
  $('needLines').addEventListener('change', async (e) => {
    if (e.target.dataset.act !== 'need-qty') return;
    const n = S.needs[S.needId];
    const lid = e.target.closest('[data-line]').dataset.line;
    const q = Math.max(1, parseInt(e.target.value, 10) || 1);
    await saveNeed({ ...n, lines: n.lines.map((l) => (l.id === lid ? { ...l, qty: q } : l)) });
    renderNeeds();
  });
  $('needBack').onclick = () => { S.needId = null; renderNeeds(); };
  $('needTitle').onclick = () => {
    const n = S.needs[S.needId];
    openSheet(`<div class="top"><h2>Umbenennen</h2><button class="small" data-act="close">Abbrechen</button></div><input id="rn" value="${esc(n.name)}"><button class="primary" data-act="ok">Speichern</button>`, async (a) => {
      if (a === 'close') closeSheet();
      if (a === 'ok') { const v = $('rn').value.trim(); if (v) await saveNeed({ ...n, name: v }); closeSheet(); renderNeeds(); }
    });
  };
  $('stockSearch').oninput = renderStock;
  $('onlyInStock').onchange = renderStock;
  $('onlyOpen').onchange = renderStock;
  $('openSettings').onclick = settingsSheet;
  $('openExcel').onclick = excelSheet;
  $('openReview').onclick = () => showView('review');
  $('checkChip').onclick = () => showView('review');
  $('logMore').onclick = async () => {
    const more = await store.recentLog(200, S.logItems.at(-1)?.t ?? Infinity);
    S.logItems.push(...more); S.logDone = more.length < 200; renderLog();
  };
  document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => showView(b.dataset.view)));

  document.addEventListener('click', async (ev) => {
    const el = ev.target.closest('[data-act],[data-go]');
    if (!el) return;
    if (el.dataset.go) { showView(el.dataset.go); return; }
    const act = el.dataset.act;
    if (ev.target.closest('#sheetRoot')) { if (sheetHandler) await sheetHandler(act, el); return; }
    const n = S.needId && S.needs[S.needId];
    if (act === 'minus' || act === 'plus') {
      S.basket = basketAdd(S.basket, el.closest('.line').dataset.ean, act === 'plus' ? 1 : -1); S.shortOk = false;
      await saveSession(); renderBasket();
    } else if (act === 'short-ok') { S.shortOk = true; await bookBasket(); }
    else if (act === 'undo') await undo(el.dataset.id);
    else if (act === 'product') productSheet(el.dataset.ean);
    else if (act === 'job') jobSheet(el.dataset.id);
    else if (act === 'check-now') maybeRunCheck(true);
    else if (act === 'settings') settingsSheet();
    else if (act === 'excel-save') saveExcel();
    else if (act === 'regrant') regrantFile();
    else if (act === 'merge-dupe') await merge(el.dataset.from, el.dataset.into);
    else if (act === 'dismiss-dupe') {
      const k = [el.dataset.a, el.dataset.b].sort().join('|');
      await setSetting('dismissed', [...setting('dismissed', []), k]);
      await setSetting('dupes', setting('dupes', []).filter((d) => [d.a, d.b].sort().join('|') !== k));
      renderReview();
    }
    else if (act === 'need') { S.needId = el.dataset.id; renderNeeds(); window.scrollTo(0, 0); }
    else if (act === 'need-sug' && n) {
      const raw = $('needLine').value;
      $('needLine').value = ''; $('needSuggest').innerHTML = '';
      await addNeedLine(n, raw, el.dataset.ean);
      renderNeeds(); $('needLine').focus();
    }
    else if (act === 'need-assign' && n) assignSheet(n.id, el.dataset.line);
    else if (act === 'need-del' && n) { await saveNeed({ ...n, lines: n.lines.filter((l) => l.id !== el.dataset.line) }); renderNeeds(); }
    else if (act === 'need-claude' && n) await claudeMatch(n);
    else if (act === 'need-take' && n) await takeOutAvailable(n);
    else if (act === 'need-close' && n) { await saveNeed({ ...n, closed: !n.closed }); renderNeeds(); }
    else if (act === 'need-delete' && n) {
      openSheet(`<div class="top"><h2>Liste löschen?</h2><button class="small" data-act="close">Abbrechen</button></div><p>„${esc(n.name)}“ mit ${plural((n.lines || []).length, 'Position', 'Positionen')} wird gelöscht. Bestand und Buchungen bleiben.</p><button class="primary danger-bg" data-act="ok">Löschen</button>`, async (a) => {
        if (a === 'close') closeSheet();
        if (a === 'ok') { delete S.needs[n.id]; await store.deleteNeed(n.id); changed(); S.needId = null; closeSheet(); renderNeeds(); }
      });
    }
    else if (act === 'copy-order' && n) await copyText(orderText(orderList([{ ...n, closed: false }], S.products, S.jobs)));
    else if (act === 'copy-order-all') await copyText(orderText(orderList(Object.values(S.needs), S.products, S.jobs)));
  });
  $('sheetRoot').addEventListener('click', (ev) => { if (ev.target.classList.contains('sheet-back')) closeSheet(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
  window.addEventListener('online', () => { S.checkRetryAt = 0; maybeRunCheck(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && S.camera) stopCamera(); });
}

async function start() {
  bind();
  if (ARTIFACT) {
    document.querySelector('.camera').hidden = true; // the live camera is not available inside claude.ai
  }
  try { await storeReady; } catch (e) { scanMsg(esc(e.message), 'err'); return; }
  if (ARTIFACT) S.ai = await (await lazyAi()).capabilities().catch(() => null);
  // Another device changed something: take the new state.
  store.onChange?.(async () => {
    const fresh = await store.loadAll();
    S.products = fresh.products; S.jobs = fresh.jobs; S.needs = fresh.needs;
    S.meta = { ...fresh.meta, apiKey: S.meta.apiKey };
    await refreshLogs();
    renderAll();
  });
  const all = await store.loadAll();
  S.products = all.products; S.jobs = all.jobs; S.needs = all.needs; S.meta = all.meta;
  const sess = setting('session', null);
  if (sess) { S.mode = sess.mode || 'in'; S.jobId = sess.jobId || ''; S.basket = sess.basket || []; }
  S.dirty = setting('dirty', 0); S.savedAt = setting('lastExport', 0);
  S.fileHandle = setting('fileHandle', null);
  if (S.fileHandle?.queryPermission) S.fileOk = (await S.fileHandle.queryPermission({ mode: 'readwrite' }).catch(() => 'denied')) === 'granted';
  await refreshLogs();
  renderAll();
  for (const p of Object.values(S.products)) if (p.status === 'new') readNewLabel(p.ean, p.hasImage ? store.getImage(p.ean) : null);
  // Basket lines whose product never got saved (e.g. after a failed save): create them now so they can be booked.
  for (const l of S.basket) if (!S.products[l.ean]) await createProduct(l.ean, null);
  if (S.basket.length) renderAll();
  maybeRunCheck();
  if (!window.isSecureContext) scanMsg('Die Kamera braucht eine sichere (https) Adresse.', 'err');
}

window.__lager = { handleCode, state: S, maybeRunCheck, identifySheet, scanProduct };
start().catch((e) => { document.body.insertAdjacentHTML('afterbegin', `<div class="msg err">App konnte nicht starten: ${esc(e.message)}</div>`); });
