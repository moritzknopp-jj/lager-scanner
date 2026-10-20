// Storage for the claude.ai version: the artifact's shared database, synced live between devices.
// Same functions as db.js so the app code does not care where data lives.
//
// Layout (each line is one document):
//   catalog/s00 … s99   { products: { code: product } }   products sharded by code
//   log/<day>_<n>       { day, part, entries: [...] }     bookings, one doc per day (split when large)
//   jobs/<id>, needs/<id>, meta/<key> { v }
//   meta/images         { v: { code: assetId } }          label photos live in the asset store

let db = null;
let assets = null;
let readyP = null;
const C = { shards: {}, products: {}, jobs: {}, needs: {}, meta: {}, logDocs: [] };
const listeners = new Set();
const imgCache = new Map(); // photos of this session, so Claude gets them without a download

const rid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
export const newId = rid;
const day = (t = Date.now()) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

export function shardOf(code) {
  if (/^\d{2,}$/.test(code)) return 's' + code.slice(-2);
  let h = 0;
  for (const c of String(code)) h = (h * 31 + c.charCodeAt(0)) % 100;
  return 's' + String(h).padStart(2, '0');
}

// ---------- writes: one at a time, in order ----------
let chain = Promise.resolve();
function write(fn) {
  const job = chain.then(fn);
  chain = job.catch(() => {});
  return job.catch((e) => {
    throw new Error(e?.code === 'quota_exceeded'
      ? 'Der Speicher in claude.ai ist voll. Bitte Excel sichern und alte Buchungen archivieren.'
      : 'Speichern fehlgeschlagen: ' + (e?.message || e?.code || e));
  });
}
const clone = (o) => JSON.parse(JSON.stringify(o));

// Writes not yet confirmed. A sync update that arrives meanwhile must not undo them,
// so every snapshot is overlaid with these before it reaches the cache.
const pending = new Map(); // 'collection/id' -> data, or null for a delete
function setDoc(path, data) {
  pending.set(path, data);
  return write(() => (data === null ? db.doc(path).delete() : db.doc(path).set(data))).finally(() => {
    if (pending.get(path) === data) pending.delete(path);
  });
}
function overlay(collection, map) {
  for (const [path, data] of pending) {
    const [c, id] = path.split('/');
    if (c !== collection) continue;
    if (data === null) delete map[id]; else map[id] = data;
  }
  return map;
}

function saveShard(id) {
  return setDoc('catalog/' + id, { products: clone(C.shards[id]?.products || {}) });
}
function saveLogDoc(doc) {
  return setDoc('log/' + doc.id, { day: doc.day, part: doc.part, entries: clone(doc.entries) });
}

// ---------- live cache ----------
function rebuildProducts() {
  const out = {};
  for (const sh of Object.values(C.shards)) Object.assign(out, sh.products || {});
  C.products = out;
}
function notify() { for (const fn of listeners) { try { fn(); } catch (e) { console.error(e); } } }

function subscribe(query, apply) {
  return new Promise((resolve, reject) => {
    let first = true;
    query.onSnapshot((snap) => {
      apply(snap);
      if (first) { first = false; resolve(); } else if (!snap.metadata?.hasPendingWrites) notify();
    }, (e) => { if (first) reject(e); else console.error('sync stopped', e); });
  });
}

const LOG_DAYS = 120;
export function openStore() {
  readyP = (async () => {
    db = await window.claude?.use?.('db');
    if (!db) throw new Error('Bitte bei claude.ai anmelden – sonst kann nichts gespeichert werden.');
    assets = await window.claude.use('assets').catch(() => null);
    const docsToMap = (name, snap) => overlay(name, Object.fromEntries(snap.docs.map((d) => [d.id, d.data()])));
    await Promise.all([
      subscribe(db.collection('catalog'), (s) => { C.shards = docsToMap('catalog', s); rebuildProducts(); }),
      subscribe(db.collection('jobs'), (s) => { C.jobs = docsToMap('jobs', s); }),
      subscribe(db.collection('needs'), (s) => { C.needs = docsToMap('needs', s); }),
      subscribe(db.collection('meta'), (s) => { C.meta = Object.fromEntries(Object.entries(docsToMap('meta', s)).map(([k, d]) => [k, d.v])); }),
      subscribe(db.collection('log').orderBy('day', 'desc').limit(LOG_DAYS), (s) => {
        C.logDocs = Object.entries(docsToMap('log', s)).map(([id, d]) => ({ id, ...d })).sort((a, b) => (a.day === b.day ? b.part - a.part : a.day < b.day ? 1 : -1));
      }),
    ]);
  })();
  return readyP;
}
export const ready = () => readyP;
// Called when another device changed something.
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export async function loadAll() {
  await readyP;
  const meta = { ...C.meta };
  delete meta.images;
  return { products: clone(C.products), jobs: clone(C.jobs), needs: clone(C.needs), meta: clone(meta) };
}

export async function setMeta(key, value) {
  C.meta[key] = value;
  await setDoc('meta/' + key, { v: value === undefined ? null : clone(value) });
}

export async function putProduct(p) {
  const id = shardOf(p.ean);
  C.shards[id] ||= { products: {} };
  C.shards[id].products = { ...(C.shards[id].products || {}), [p.ean]: clone(p) };
  C.products[p.ean] = clone(p);
  await saveShard(id);
  return p;
}

export async function putJob(j) { C.jobs[j.id] = clone(j); await setDoc('jobs/' + j.id, clone(j)); return j; }
export async function putNeed(n) { C.needs[n.id] = clone(n); await setDoc('needs/' + n.id, clone(n)); return n; }
export async function deleteNeed(id) { delete C.needs[id]; await setDoc('needs/' + id, null); }

// ---------- photos ----------
export async function putImage(code, blob) {
  imgCache.set(code, blob);
  if (!assets) return;
  try {
    const r = await assets.upload(blob);
    const map = { ...(C.meta.images || {}), [code]: r.id };
    await setMeta('images', map);
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
  imgCache.delete(code);
  const id = C.meta.images?.[code];
  if (!id) return;
  const map = { ...C.meta.images };
  delete map[code];
  await setMeta('images', map);
  try { await assets?.delete(id); } catch { /* already gone */ }
}

// ---------- bookings ----------
function todayDoc() {
  const d = day();
  let doc = C.logDocs.filter((x) => x.day === d).sort((a, b) => b.part - a.part)[0];
  if (!doc || JSON.stringify(doc.entries).length > 180000) {
    const part = doc ? doc.part + 1 : 0;
    doc = { id: d + '_' + part, day: d, part, entries: [] };
    C.logDocs.unshift(doc);
  }
  return doc;
}
async function appendEntries(entries) {
  const doc = todayDoc();
  doc.entries = [...doc.entries, ...entries];
  await saveLogDoc(doc);
}
const cachedEntries = () => C.logDocs.flatMap((d) => d.entries || []);

export async function addLog(entry) {
  const e = { id: rid(), t: Date.now(), ...entry };
  await appendEntries([e]);
  return e;
}
export async function recentLog(limit = 200, beforeT = Infinity) {
  await readyP;
  return cachedEntries().filter((e) => e.t < beforeT).sort((a, b) => b.t - a.t).slice(0, limit);
}
export async function logForProduct(ean, limit = 50) {
  await readyP;
  return cachedEntries().filter((e) => e.e === ean).sort((a, b) => b.t - a.t).slice(0, limit);
}
export async function allLog() {
  await readyP;
  const snap = await db.collection('log').orderBy('day', 'desc').limit(1000).get();
  return snap.docs.flatMap((d) => d.data().entries || []).sort((a, b) => a.t - b.t);
}

export async function bookLines({ kind, lines, jobId = null, basketId = rid(), note = '' }) {
  await readyP;
  let job = null;
  if (kind === 'out') {
    job = C.jobs[jobId] && clone(C.jobs[jobId]);
    if (!job) throw new Error('Auftrag nicht gefunden. Bitte vor dem Entnehmen einen Auftrag wählen.');
    job.items ||= {};
  }
  const now = Date.now();
  const changed = [];
  const entries = [];
  const shards = new Set();
  let i = 0;
  for (const l of lines) {
    if (!l.qty) continue;
    const p = C.products[l.ean];
    if (!p) throw new Error('Unbekanntes Produkt ' + l.ean);
    const delta = kind === 'in' ? l.qty : -l.qty;
    const np = { ...p, qty: (p.qty || 0) + delta, updated: now };
    const sid = shardOf(np.ean);
    C.shards[sid].products = { ...C.shards[sid].products, [np.ean]: np };
    C.products[np.ean] = np;
    shards.add(sid);
    changed.push(np);
    const e = { id: rid() + (i++), t: now, k: kind, e: l.ean, q: delta, b: basketId };
    if (job) e.j = jobId;
    if (note) e.note = note;
    entries.push(e);
    if (job) job.items[l.ean] = (job.items[l.ean] || 0) + l.qty;
  }
  await appendEntries(entries);
  for (const sid of shards) await saveShard(sid);
  if (job) await putJob(job);
  return { products: changed, job, entries };
}

function findEntry(id) {
  for (const d of C.logDocs) {
    const idx = (d.entries || []).findIndex((e) => e.id === id);
    if (idx >= 0) return { doc: d, idx };
  }
  return null;
}

export async function undoEntry(id) {
  await readyP;
  const f = findEntry(id);
  const e = f && f.doc.entries[f.idx];
  if (!e || !['in', 'out', 'adjust'].includes(e.k)) throw new Error('Diese Buchung kann nicht storniert werden.');
  if (e.undone) throw new Error('Bereits storniert.');
  const p = C.products[e.e];
  const np = p ? { ...p, qty: (p.qty || 0) - e.q, updated: Date.now() } : null;
  let job = null;
  if (e.k === 'out' && e.j && C.jobs[e.j]) {
    job = clone(C.jobs[e.j]);
    job.items ||= {};
    job.items[e.e] = (job.items[e.e] || 0) + e.q;
    if (job.items[e.e] <= 0) delete job.items[e.e];
  }
  f.doc.entries = f.doc.entries.map((x) => (x.id === id ? { ...x, undone: true } : x));
  await saveLogDoc(f.doc);
  const rev = { id: rid(), t: Date.now(), k: 'undo', e: e.e, q: -e.q, r: e.id };
  if (e.j) rev.j = e.j;
  await appendEntries([rev]);
  if (np) await putProduct(np);
  if (job) await putJob(job);
  return { product: np, job, entry: rev };
}

export async function adjustCount(ean, newQty) {
  await readyP;
  const p = C.products[ean];
  const delta = newQty - (p.qty || 0);
  const np = { ...p, qty: newQty, updated: Date.now() };
  let e = null;
  if (delta) e = await addLog({ k: 'adjust', e: ean, q: delta });
  await putProduct(np);
  return { product: np, entry: e };
}

export async function mergeProducts(fromEan, intoEan) {
  await readyP;
  if (fromEan === intoEan) throw new Error('Ein Produkt kann nicht mit sich selbst zusammengeführt werden.');
  const from = C.products[fromEan], into = C.products[intoEan];
  if (!from || !into) throw new Error('Produkt nicht gefunden.');
  if (into.aliasOf) throw new Error('Das Zielprodukt ist selbst schon mit einem anderen zusammengeführt.');
  const moved = from.qty || 0;
  const now = Date.now();
  const nInto = {
    ...into, qty: (into.qty || 0) + moved,
    aliases: [...new Set([...(into.aliases || []), fromEan, ...(from.aliases || [])])],
    name: into.name || from.name, maker: into.maker || from.maker, model: into.model || from.model,
    category: into.category || from.category, series: into.series || from.series, variant: into.variant || from.variant,
    updated: now,
  };
  await putProduct(nInto);
  await putProduct({ ...from, qty: 0, aliasOf: intoEan, aliases: [], updated: now });
  for (const a of from.aliases || []) if (C.products[a]) await putProduct({ ...C.products[a], aliasOf: intoEan, updated: now });
  const jobs = [];
  for (const j of Object.values(C.jobs)) {
    if (j.items && j.items[fromEan]) {
      const items = { ...j.items };
      items[intoEan] = (items[intoEan] || 0) + items[fromEan];
      delete items[fromEan];
      jobs.push(await putJob({ ...j, items }));
    }
  }
  for (const n of Object.values(C.needs)) {
    if ((n.lines || []).some((l) => l.code === fromEan)) await putNeed({ ...n, lines: n.lines.map((l) => (l.code === fromEan ? { ...l, code: intoEan } : l)) });
  }
  await appendEntries([{ id: rid(), t: now, k: 'merge', e: intoEan, q: moved, from: fromEan }]);
  return { into: nInto, jobs };
}

export async function exportAll() {
  await readyP;
  return { products: Object.values(clone(C.products)), log: await allLog(), jobs: Object.values(clone(C.jobs)), needs: Object.values(clone(C.needs)) };
}

// Replace everything with a backup (from the Excel file).
export async function importAll({ products, log, jobs, needs = [] }) {
  await readyP;
  for (const name of ['catalog', 'log', 'jobs', 'needs']) {
    const snap = await db.collection(name).limit(1000).get();
    for (const d of snap.docs) await setDoc(name + '/' + d.id, null);
  }
  C.shards = {}; C.products = {}; C.jobs = {}; C.needs = {}; C.logDocs = [];
  for (const p of products) {
    const id = shardOf(p.ean);
    C.shards[id] ||= { products: {} };
    C.shards[id].products[p.ean] = p;
    C.products[p.ean] = p;
  }
  for (const id of Object.keys(C.shards)) await saveShard(id);
  const byDay = {};
  for (const e of log) (byDay[day(e.t)] ||= []).push(e);
  for (const [d, entries] of Object.entries(byDay)) {
    const doc = { id: d + '_0', day: d, part: 0, entries };
    C.logDocs.push(doc);
    await saveLogDoc(doc);
  }
  C.logDocs.sort((a, b) => (a.day < b.day ? 1 : -1));
  for (const j of jobs) await putJob(j);
  for (const n of needs) await putNeed(n);
}
