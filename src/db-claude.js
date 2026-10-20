// Storage for the claude.ai version: the artifact's shared database, synced live between devices.
// Same functions as db.js so the app code does not care where data lives.
//
// Rule that keeps stock correct with several devices and late sync updates:
// the booking log is the only truth for quantities. Stock and job counts are always
// calculated from it, and every write only ADDS (merge-update of one key), so an old
// copy of a document can never overwrite newer data.
//
// Layout (each line is one document):
//   catalog/s00 … s99   { products: { code: product } }      descriptive fields only, sharded by code
//   log/<day>_<n>       { day, part, entries: { id: entry } } bookings; append = merge one key
//   jobs/<id>, needs/<id>, meta/<key> { v }
//   meta/images         { v: { code: assetId } }             label photos live in the asset store

let db = null;
let assets = null;
let readyP = null;
const C = { shards: {}, products: {}, jobs: {}, needs: {}, meta: {}, logDocs: [] };
const listeners = new Set();
const imgCache = new Map();

const rid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
export const newId = rid;
const day = (t = Date.now()) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function shardOf(code) {
  if (/^\d{2,}$/.test(code)) return 's' + code.slice(-2);
  let h = 0;
  for (const c of String(code)) h = (h * 31 + c.charCodeAt(0)) % 100;
  return 's' + String(h).padStart(2, '0');
}

// Same semantics as the platform's update(): nested objects merge, everything else replaces.
function deepMerge(target, patch) {
  const out = isObj(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : clone(v);
  return out;
}

// ---------- writes: one at a time, in order ----------
let chain = Promise.resolve();
function queue(fn) {
  const job = chain.then(fn);
  chain = job.catch(() => {});
  return job.catch((e) => {
    throw new Error(e?.code === 'quota_exceeded'
      ? 'Der Speicher in claude.ai ist voll. Bitte Excel sichern und alte Buchungen archivieren.'
      : 'Speichern fehlgeschlagen: ' + (e?.message || e?.code || e));
  });
}

// Our writes are re-applied to incoming snapshots until a snapshot shows them. A snapshot fetched
// before our write landed (periodic refresh) therefore cannot roll it back, while a later change
// from another device (arriving after the server has our write) is taken as it is.
const RECENT_MS = 5 * 60 * 1000;
const recent = []; // { path, op: 'merge'|'set'|'delete', data, at }
function remember(path, op, data) { recent.push({ path, op, data: clone(data), at: Infinity }); return recent[recent.length - 1]; }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function contains(doc, patch) {
  if (!isObj(patch)) return same(doc, patch);
  if (!isObj(doc)) return false;
  return Object.entries(patch).every(([k, v]) => (isObj(v) ? contains(doc[k], v) : same(doc[k], v)));
}
function overlay(collection, map) {
  const now = Date.now();
  for (let i = recent.length - 1; i >= 0; i--) {
    const r = recent[i];
    const [c, id] = r.path.split('/');
    if (c !== collection) continue;
    const confirmed = r.at !== Infinity;
    const shows = r.op === 'delete' ? !(id in map) : r.op === 'set' ? same(map[id], r.data) : contains(map[id], r.data);
    if ((confirmed && shows) || r.at < now - RECENT_MS) recent.splice(i, 1); // the server has it (or it is old): stop
  }
  for (const r of recent) {
    const [c, id] = r.path.split('/');
    if (c !== collection) continue;
    if (r.op === 'delete') delete map[id];
    else if (r.op === 'set') map[id] = clone(r.data);
    else map[id] = deepMerge(map[id], r.data);
  }
  return map;
}

// Merge-update; creates the document if it does not exist yet.
function mergeDoc(path, patch) {
  const rec = remember(path, 'merge', patch);
  return queue(async () => {
    try { await db.doc(path).update(patch); }
    catch (e) { if (e?.code === 'invalid_argument') await db.doc(path).set(patch); else throw e; }
  }).finally(() => { rec.at = Date.now(); });
}
function setDoc(path, data) {
  const rec = remember(path, data === null ? 'delete' : 'set', data);
  return queue(() => (data === null ? db.doc(path).delete() : db.doc(path).set(data))).finally(() => { rec.at = Date.now(); });
}

// ---------- calculated state ----------
const entriesOf = (doc) => (Array.isArray(doc.entries) ? doc.entries : Object.values(doc.entries || {}));
const cachedEntries = () => C.logDocs.flatMap(entriesOf);

function masterCode(code) {
  let c = code;
  const seen = new Set();
  while (C.products[c]?.aliasOf && !seen.has(c)) { seen.add(c); c = C.products[c].aliasOf; }
  return c;
}

// Stock and job counts from the log. Merged products count on the product they were merged into.
function recompute() {
  const qty = {};
  const jobItems = {};
  for (const e of cachedEntries()) {
    if (!['in', 'out', 'adjust', 'undo'].includes(e.k)) continue;
    const m = masterCode(e.e);
    qty[m] = (qty[m] || 0) + (Number(e.q) || 0);
    if (e.j && (e.k === 'out' || e.k === 'undo')) {
      jobItems[e.j] ||= {};
      jobItems[e.j][m] = (jobItems[e.j][m] || 0) - (Number(e.q) || 0);
    }
  }
  for (const [code, p] of Object.entries(C.products)) p.qty = p.aliasOf ? 0 : qty[code] || 0;
  for (const [id, j] of Object.entries(C.jobs)) {
    const items = {};
    for (const [code, n] of Object.entries(jobItems[id] || {})) if (n > 0) items[code] = n;
    j.items = items;
  }
}

function rebuildProducts() {
  const out = {};
  for (const sh of Object.values(C.shards)) for (const [code, p] of Object.entries(sh.products || {})) out[code] = { ...p };
  C.products = out;
}
function notify() { for (const fn of listeners) { try { fn(); } catch (e) { console.error(e); } } }
// After our own writes too, so the app always shows the quantities calculated from the log.
let localTimer = null;
function localChanged() { clearTimeout(localTimer); localTimer = setTimeout(notify, 30); }

function subscribe(query, apply) {
  return new Promise((resolve, reject) => {
    let first = true;
    query.onSnapshot((snap) => {
      apply(snap);
      recompute();
      if (first) { first = false; resolve(); } else if (!snap.metadata?.hasPendingWrites) notify();
    }, (e) => { if (first) reject(e); else console.error('sync stopped', e); });
  });
}

const sortLog = (docs) => docs.sort((a, b) => (a.day === b.day ? b.part - a.part : a.day < b.day ? 1 : -1));

export function openStore() {
  readyP = (async () => {
    db = await window.claude?.use?.('db');
    if (!db) throw new Error('Bitte bei claude.ai anmelden – sonst kann nichts gespeichert werden.');
    assets = await window.claude.use('assets').catch(() => null);
    // Snapshot data from claude.ai is read-only: keep our own copies.
    const docsToMap = (name, snap) => overlay(name, Object.fromEntries(snap.docs.map((d) => [d.id, clone(d.data())])));
    await Promise.all([
      subscribe(db.collection('catalog'), (s) => { C.shards = docsToMap('catalog', s); rebuildProducts(); }),
      subscribe(db.collection('jobs'), (s) => { C.jobs = docsToMap('jobs', s); }),
      subscribe(db.collection('needs'), (s) => { C.needs = docsToMap('needs', s); }),
      subscribe(db.collection('meta'), (s) => { C.meta = Object.fromEntries(Object.entries(docsToMap('meta', s)).map(([k, d]) => [k, d.v])); }),
      subscribe(db.collection('log').orderBy('day', 'desc').limit(1000), (s) => {
        C.logDocs = sortLog(Object.entries(docsToMap('log', s)).map(([id, d]) => ({ id, ...d })));
      }),
    ]);
    // Older log documents kept entries as an array, which a merge cannot extend: convert once.
    for (const d of C.logDocs) {
      if (Array.isArray(d.entries)) {
        d.entries = Object.fromEntries(d.entries.map((e) => [e.id, e]));
        await setDoc('log/' + d.id, { day: d.day, part: d.part, entries: d.entries });
      }
    }
  })();
  return readyP;
}
export const ready = () => readyP;
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export async function loadAll() {
  await readyP;
  recompute();
  const meta = { ...C.meta };
  delete meta.images;
  return { products: clone(C.products), jobs: clone(C.jobs), needs: clone(C.needs), meta: clone(meta) };
}

export async function setMeta(key, value) {
  C.meta[key] = value;
  await setDoc('meta/' + key, { v: value === undefined ? null : clone(value) });
}

// Descriptive fields only; the quantity always comes from the log.
export async function putProduct(p) {
  const { qty, ...fields } = clone(p);
  const id = shardOf(p.ean);
  C.shards[id] = deepMerge(C.shards[id], { products: { [p.ean]: fields } });
  C.products[p.ean] = { ...C.products[p.ean], ...fields };
  recompute();
  localChanged();
  await mergeDoc('catalog/' + id, { products: { [p.ean]: fields } });
  return { ...p, qty: C.products[p.ean].qty };
}

export async function putJob(j) {
  const { items, ...fields } = clone(j); // items come from the log
  C.jobs[j.id] = { ...C.jobs[j.id], ...fields };
  recompute();
  await mergeDoc('jobs/' + j.id, fields);
  return clone(C.jobs[j.id]);
}
export async function putNeed(n) { C.needs[n.id] = clone(n); await setDoc('needs/' + n.id, clone(n)); return n; }
export async function deleteNeed(id) { delete C.needs[id]; await setDoc('needs/' + id, null); }

// ---------- photos ----------
export async function putImage(code, blob) {
  imgCache.set(code, blob);
  if (!assets) return;
  try {
    const r = await assets.upload(blob);
    C.meta.images = { ...(C.meta.images || {}), [code]: r.id };
    await mergeDoc('meta/images', { v: { [code]: r.id } });
  } catch (e) { console.warn('photo not stored', e); }
}
export async function getImage(code) {
  if (imgCache.has(code)) return imgCache.get(code);
  const id = C.meta.images?.[code];
  if (!id) return null;
  try {
    const res = await fetch('/_blob/' + id);
    if (!res.ok) return null;
    const b = await res.blob();
    imgCache.set(code, b);
    return b;
  } catch { return null; }
}
export async function deleteImage(code) {
  // Photos are kept: the correction agent needs them later. Only the local copy is dropped.
  imgCache.delete(code);
}
export const imageIds = () => ({ ...(C.meta.images || {}) });

// ---------- bookings ----------
function todayDoc() {
  const d = day();
  let doc = C.logDocs.filter((x) => x.day === d).sort((a, b) => b.part - a.part)[0];
  if (!doc || JSON.stringify(doc.entries).length > 180000) {
    const part = doc ? doc.part + 1 : 0;
    doc = { id: d + '_' + part, day: d, part, entries: {} };
    C.logDocs.unshift(doc);
  }
  return doc;
}
async function appendEntries(entries) {
  const doc = todayDoc();
  const add = Object.fromEntries(entries.map((e) => [e.id, e]));
  doc.entries = { ...(Array.isArray(doc.entries) ? Object.fromEntries(doc.entries.map((e) => [e.id, e])) : doc.entries), ...add };
  recompute();
  localChanged();
  await mergeDoc('log/' + doc.id, { day: doc.day, part: doc.part, entries: add });
}

export async function addLog(entry) {
  const e = { id: rid(), t: Date.now(), ...entry };
  await appendEntries([e]);
  return e;
}
export async function recentLog(limit = 200, beforeT = Infinity) {
  await readyP;
  return cachedEntries().filter((e) => e.t < beforeT).sort((a, b) => b.t - a.t).slice(0, limit).map((e) => ({ ...e }));
}
export async function logForProduct(ean, limit = 50) {
  await readyP;
  return cachedEntries().filter((e) => e.e === ean).sort((a, b) => b.t - a.t).slice(0, limit).map((e) => ({ ...e }));
}
export async function allLog() {
  await readyP;
  return cachedEntries().map((e) => ({ ...e })).sort((a, b) => a.t - b.t);
}

export async function bookLines({ kind, lines, jobId = null, basketId = rid(), note = '' }) {
  await readyP;
  if (kind === 'out' && !C.jobs[jobId]) throw new Error('Auftrag nicht gefunden. Bitte vor dem Entnehmen einen Auftrag wählen.');
  const now = Date.now();
  const entries = [];
  let i = 0;
  for (const l of lines) {
    if (!l.qty) continue;
    if (!C.products[l.ean]) throw new Error('Unbekanntes Produkt ' + l.ean);
    const e = { id: rid() + (i++), t: now, k: kind, e: l.ean, q: kind === 'in' ? l.qty : -l.qty, b: basketId };
    if (kind === 'out') e.j = jobId;
    if (note) e.note = note;
    entries.push(e);
  }
  await appendEntries(entries);
  const products = [...new Set(entries.map((e) => e.e))].map((c) => clone(C.products[c]));
  return { products, job: kind === 'out' ? clone(C.jobs[jobId]) : null, entries };
}

function findEntry(id) {
  for (const d of C.logDocs) {
    const e = entriesOf(d).find((x) => x.id === id);
    if (e) return { doc: d, e };
  }
  return null;
}

export async function undoEntry(id) {
  await readyP;
  const f = findEntry(id);
  const e = f?.e;
  if (!e || !['in', 'out', 'adjust'].includes(e.k)) throw new Error('Diese Buchung kann nicht storniert werden.');
  if (e.undone) throw new Error('Bereits storniert.');
  const marked = { ...e, undone: true };
  f.doc.entries = { ...(Array.isArray(f.doc.entries) ? Object.fromEntries(f.doc.entries.map((x) => [x.id, x])) : f.doc.entries), [id]: marked };
  await mergeDoc('log/' + f.doc.id, { entries: { [id]: marked } });
  const rev = { id: rid(), t: Date.now(), k: 'undo', e: e.e, q: -e.q, r: e.id };
  if (e.j) rev.j = e.j;
  await appendEntries([rev]);
  return { product: clone(C.products[e.e]), job: e.j ? clone(C.jobs[e.j]) : null, entry: rev };
}

// Marks a booking as checked (kept on purpose), so the correction agent leaves it alone.
export async function confirmEntry(id) {
  await readyP;
  const f = findEntry(id);
  if (!f) return;
  const marked = { ...f.e, ok: true };
  f.doc.entries = { ...(Array.isArray(f.doc.entries) ? Object.fromEntries(f.doc.entries.map((x) => [x.id, x])) : f.doc.entries), [id]: marked };
  await mergeDoc('log/' + f.doc.id, { entries: { [id]: marked } });
}

export async function adjustCount(ean, newQty) {
  await readyP;
  recompute();
  const delta = newQty - (C.products[ean].qty || 0);
  let e = null;
  if (delta) e = await addLog({ k: 'adjust', e: ean, q: delta });
  return { product: clone(C.products[ean]), entry: e };
}

export async function mergeProducts(fromEan, intoEan) {
  await readyP;
  if (fromEan === intoEan) throw new Error('Ein Produkt kann nicht mit sich selbst zusammengeführt werden.');
  const from = C.products[fromEan], into = C.products[intoEan];
  if (!from || !into) throw new Error('Produkt nicht gefunden.');
  if (into.aliasOf) throw new Error('Das Zielprodukt ist selbst schon mit einem anderen zusammengeführt.');
  const moved = from.qty || 0;
  const now = Date.now();
  const fill = (k) => into[k] || from[k] || '';
  await putProduct({
    ...into,
    aliases: [...new Set([...(into.aliases || []), fromEan, ...(from.aliases || [])])],
    name: fill('name'), maker: fill('maker'), model: fill('model'), category: fill('category'), series: fill('series'),
    variant: fill('variant'), color: fill('color'), orderNo: fill('orderNo'),
    ids: [...new Set([into.ids, from.ids, fromEan].join(',').split(',').map((s) => s.trim()).filter(Boolean))].join(', '),
    updated: now,
  });
  await putProduct({ ...from, aliasOf: intoEan, aliases: [], updated: now });
  for (const a of from.aliases || []) if (C.products[a]) await putProduct({ ...C.products[a], aliasOf: intoEan, updated: now });
  for (const n of Object.values(C.needs)) {
    if ((n.lines || []).some((l) => l.code === fromEan)) await putNeed({ ...n, lines: n.lines.map((l) => (l.code === fromEan ? { ...l, code: intoEan } : l)) });
  }
  // Informational: stock follows automatically because merged codes count on the target.
  await appendEntries([{ id: rid(), t: now, k: 'merge', e: intoEan, q: moved, from: fromEan }]);
  return { into: clone(C.products[intoEan]), jobs: Object.values(clone(C.jobs)) };
}

export async function exportAll() {
  await readyP;
  recompute();
  return { products: Object.values(clone(C.products)), log: await allLog(), jobs: Object.values(clone(C.jobs)), needs: Object.values(clone(C.needs)) };
}

// Replace everything with a backup (from the Excel file). Counts typed into Excel that differ
// from the bookings become "Korrektur" entries, so the log stays the truth.
export async function importAll({ products, log, jobs, needs = [] }) {
  await readyP;
  for (const name of ['catalog', 'log', 'jobs', 'needs']) {
    const snap = await db.collection(name).limit(1000).get();
    for (const d of snap.docs) await setDoc(name + '/' + d.id, null);
  }
  C.shards = {}; C.products = {}; C.jobs = {}; C.needs = {}; C.logDocs = [];
  const byShard = {};
  for (const p of products) {
    const { qty, ...fields } = p;
    (byShard[shardOf(p.ean)] ||= {})[p.ean] = fields;
    C.products[p.ean] = { ...fields };
  }
  for (const [id, prods] of Object.entries(byShard)) { C.shards[id] = { products: prods }; await setDoc('catalog/' + id, { products: prods }); }
  const byDay = {};
  for (const e of log) (byDay[day(e.t)] ||= {})[e.id] = e;
  for (const [d, entries] of Object.entries(byDay)) {
    const doc = { id: d + '_0', day: d, part: 0, entries };
    C.logDocs.push(doc);
    await setDoc('log/' + doc.id, { day: d, part: 0, entries });
  }
  sortLog(C.logDocs);
  for (const j of jobs) { const { items, ...f } = j; C.jobs[j.id] = { ...f }; await setDoc('jobs/' + j.id, f); }
  for (const n of needs) await putNeed(n);
  recompute();
  const fixes = [];
  for (const p of products) {
    if (p.aliasOf) continue;
    const diff = (Number(p.qty) || 0) - (C.products[p.ean]?.qty || 0);
    if (diff) fixes.push({ id: rid() + fixes.length, t: Date.now(), k: 'adjust', e: p.ean, q: diff, note: 'Excel-Import' });
  }
  if (fixes.length) await appendEntries(fixes);
}
