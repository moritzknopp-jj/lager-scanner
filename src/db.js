// IndexedDB storage. Everything stays on this device; Excel export is the backup.
import { openDB } from 'idb';

const DB_NAME = 'lager-scanner';
let dbp = null;

export function openStore(name = DB_NAME) {
  dbp = openDB(name, 2, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('products', { keyPath: 'ean' });
        const log = db.createObjectStore('log', { keyPath: 'id' });
        log.createIndex('t', 't');
        log.createIndex('e', 'e');
        db.createObjectStore('jobs', { keyPath: 'id' });
        db.createObjectStore('images');
        db.createObjectStore('meta');
      }
      if (oldVersion < 2) db.createObjectStore('needs', { keyPath: 'id' });
    },
  });
  return dbp;
}

const rid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
export const newId = rid;

export async function loadAll() {
  const db = await dbp;
  const [products, jobs, needs, metaKeys] = await Promise.all([db.getAll('products'), db.getAll('jobs'), db.getAll('needs'), db.getAllKeys('meta')]);
  const meta = {};
  for (const k of metaKeys) meta[k] = await db.get('meta', k);
  return {
    products: Object.fromEntries(products.map((p) => [p.ean, p])),
    jobs: Object.fromEntries(jobs.map((j) => [j.id, j])),
    needs: Object.fromEntries(needs.map((n) => [n.id, n])),
    meta,
  };
}

export async function setMeta(key, value) {
  const db = await dbp;
  await db.put('meta', value, key);
}

export async function putProduct(p) {
  const db = await dbp;
  await db.put('products', p);
  return p;
}

export async function putNeed(n) {
  const db = await dbp;
  await db.put('needs', n);
  return n;
}
export async function deleteNeed(id) {
  const db = await dbp;
  await db.delete('needs', id);
}

export async function putJob(j) {
  const db = await dbp;
  await db.put('jobs', j);
  return j;
}

export async function putImage(ean, blob) {
  const db = await dbp;
  await db.put('images', blob, ean);
}
export async function getImage(ean) {
  const db = await dbp;
  return db.get('images', ean);
}
export async function deleteImage(ean) {
  const db = await dbp;
  await db.delete('images', ean);
}

export async function addLog(entry) {
  const db = await dbp;
  const e = { id: rid(), t: Date.now(), ...entry };
  await db.put('log', e);
  return e;
}

export async function recentLog(limit = 200, beforeT = Infinity) {
  const db = await dbp;
  const out = [];
  let cur = await db.transaction('log').store.index('t').openCursor(IDBKeyRange.upperBound(beforeT, true), 'prev');
  while (cur && out.length < limit) {
    out.push(cur.value);
    cur = await cur.continue();
  }
  return out;
}
export async function logForProduct(ean, limit = 50) {
  const db = await dbp;
  const all = await db.getAllFromIndex('log', 'e', ean);
  return all.sort((a, b) => b.t - a.t).slice(0, limit);
}
export async function allLog() {
  const db = await dbp;
  return (await db.getAll('log')).sort((a, b) => a.t - b.t);
}

// Book a whole basket in one transaction: stock, job and log change together or not at all.
// lines: [{ ean (master), qty }], kind: 'in' | 'out'. Returns { products, job, entries }.
export async function bookLines({ kind, lines, jobId = null, basketId = rid(), note = '' }) {
  const db = await dbp;
  const tx = db.transaction(['products', 'log', 'jobs'], 'readwrite');
  const ps = tx.objectStore('products');
  const now = Date.now();
  const changed = [];
  const entries = [];
  let job = null;
  if (kind === 'out') {
    job = await tx.objectStore('jobs').get(jobId);
    if (!job) throw new Error('Auftrag nicht gefunden. Bitte vor dem Entnehmen einen Auftrag wählen.');
    job = { ...job, items: { ...(job.items || {}) } };
  }
  let i = 0;
  for (const l of lines) {
    if (!l.qty) continue;
    const p = await ps.get(l.ean);
    if (!p) throw new Error('Unbekanntes Produkt ' + l.ean);
    const delta = kind === 'in' ? l.qty : -l.qty;
    const np = { ...p, qty: (p.qty || 0) + delta, updated: now };
    await ps.put(np);
    changed.push(np);
    const e = { id: rid() + (i++), t: now, k: kind, e: l.ean, q: delta, b: basketId };
    if (jobId && kind === 'out') e.j = jobId;
    if (note) e.note = note;
    await tx.objectStore('log').put(e);
    entries.push(e);
    if (job) {
      job.items[l.ean] = (job.items[l.ean] || 0) + l.qty;
    }
  }
  if (job) await tx.objectStore('jobs').put(job);
  await tx.done;
  return { products: changed, job, entries };
}

// Undo adds a reversing entry; nothing is deleted from the log.
export async function undoEntry(id) {
  const db = await dbp;
  const tx = db.transaction(['products', 'log', 'jobs'], 'readwrite');
  const log = tx.objectStore('log');
  const e = await log.get(id);
  if (!e || !['in', 'out', 'adjust'].includes(e.k)) throw new Error('Diese Buchung kann nicht storniert werden.');
  if (e.undone) throw new Error('Bereits storniert.');
  const p = await tx.objectStore('products').get(e.e);
  const np = p ? { ...p, qty: (p.qty || 0) - e.q, updated: Date.now() } : null;
  if (np) await tx.objectStore('products').put(np);
  let job = null;
  if (e.k === 'out' && e.j) {
    job = await tx.objectStore('jobs').get(e.j);
    if (job) {
      job = { ...job, items: { ...(job.items || {}) } };
      job.items[e.e] = (job.items[e.e] || 0) + e.q; // e.q is negative
      if (job.items[e.e] <= 0) delete job.items[e.e];
      await tx.objectStore('jobs').put(job);
    }
  }
  await log.put({ ...e, undone: true });
  const rev = { id: rid(), t: Date.now(), k: 'undo', e: e.e, q: -e.q, r: e.id };
  if (e.j) rev.j = e.j;
  await log.put(rev);
  await tx.done;
  return { product: np, job, entry: rev };
}

export async function adjustCount(ean, newQty) {
  const db = await dbp;
  const tx = db.transaction(['products', 'log'], 'readwrite');
  const p = await tx.objectStore('products').get(ean);
  const delta = newQty - (p.qty || 0);
  const np = { ...p, qty: newQty, updated: Date.now() };
  await tx.objectStore('products').put(np);
  let e = null;
  if (delta) {
    e = { id: rid(), t: Date.now(), k: 'adjust', e: ean, q: delta };
    await tx.objectStore('log').put(e);
  }
  await tx.done;
  return { product: np, entry: e };
}

// Merge "from" into "into": stock moves over, later scans of "from" book "into".
export async function mergeProducts(fromEan, intoEan) {
  if (fromEan === intoEan) throw new Error('Ein Produkt kann nicht mit sich selbst zusammengeführt werden.');
  const db = await dbp;
  const tx = db.transaction(['products', 'log', 'jobs', 'needs'], 'readwrite');
  const ps = tx.objectStore('products');
  const from = await ps.get(fromEan);
  const into = await ps.get(intoEan);
  if (!from || !into) throw new Error('Produkt nicht gefunden.');
  if (into.aliasOf) throw new Error('Das Zielprodukt ist selbst schon mit einem anderen zusammengeführt.');
  const moved = from.qty || 0;
  const now = Date.now();
  const nInto = {
    ...into,
    qty: (into.qty || 0) + moved,
    aliases: [...new Set([...(into.aliases || []), fromEan, ...(from.aliases || [])])],
    name: into.name || from.name,
    maker: into.maker || from.maker,
    model: into.model || from.model,
    category: into.category || from.category,
    series: into.series || from.series,
    variant: into.variant || from.variant,
    updated: now,
  };
  const nFrom = { ...from, qty: 0, aliasOf: intoEan, aliases: [], updated: now };
  await ps.put(nInto);
  await ps.put(nFrom);
  // Products that pointed at "from" now point at "into".
  for (const a of from.aliases || []) {
    const ap = await ps.get(a);
    if (ap) await ps.put({ ...ap, aliasOf: intoEan, updated: now });
  }
  // Jobs: move counts over to the surviving product.
  const js = tx.objectStore('jobs');
  const jobs = await js.getAll();
  const changedJobs = [];
  for (const j of jobs) {
    if (j.items && j.items[fromEan]) {
      const items = { ...j.items };
      items[intoEan] = (items[intoEan] || 0) + items[fromEan];
      delete items[fromEan];
      const nj = { ...j, items };
      await js.put(nj);
      changedJobs.push(nj);
    }
  }
  const ns = tx.objectStore('needs');
  for (const n of await ns.getAll()) {
    if ((n.lines || []).some((l) => l.code === fromEan)) await ns.put({ ...n, lines: n.lines.map((l) => (l.code === fromEan ? { ...l, code: intoEan } : l)) });
  }
  await tx.objectStore('log').put({ id: rid(), t: now, k: 'merge', e: intoEan, q: moved, from: fromEan });
  await tx.done;
  return { into: nInto, from: nFrom, jobs: changedJobs };
}

export async function exportAll() {
  const db = await dbp;
  const [products, log, jobs, needs] = await Promise.all([db.getAll('products'), db.getAll('log'), db.getAll('jobs'), db.getAll('needs')]);
  return { products, log: log.sort((a, b) => a.t - b.t), jobs, needs };
}

// Replace everything with a backup (from the Excel file).
export async function importAll({ products, log, jobs, needs = [] }) {
  const db = await dbp;
  const tx = db.transaction(['products', 'log', 'jobs', 'images', 'needs'], 'readwrite');
  await Promise.all(['products', 'log', 'jobs', 'images', 'needs'].map((n) => tx.objectStore(n).clear()));
  for (const n of needs) await tx.objectStore('needs').put(n);
  for (const p of products) await tx.objectStore('products').put(p);
  for (const e of log) await tx.objectStore('log').put(e);
  for (const j of jobs) await tx.objectStore('jobs').put(j);
  await tx.done;
}
