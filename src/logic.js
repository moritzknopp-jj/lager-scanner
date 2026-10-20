// Pure helpers: no DOM, no storage. Covered by tests/logic.test.js.

export function gtinValid(d) {
  if (!/^\d+$/.test(d) || d.length < 2) return false;
  let sum = 0;
  for (let i = d.length - 2, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(d[i]) * w;
  return (10 - (sum % 10)) % 10 === Number(d[d.length - 1]);
}

// One key per product: UPC-A (12 digits) becomes EAN-13 with a leading 0.
export function normalizeCode(raw) {
  const code = String(raw ?? '').trim().replace(/\s+/g, '');
  if (!code) return { error: 'Kein Code.' };
  if (/^\d+$/.test(code) && [8, 12, 13, 14].includes(code.length)) {
    if (!gtinValid(code)) return { error: 'Prüfziffer stimmt nicht. Wahrscheinlich ist eine Ziffer falsch gelesen – bitte nochmal scannen oder tippen.' };
    return { code: code.length === 12 ? '0' + code : code };
  }
  if (code.length > 64) return { error: 'Code ist zu lang.' };
  return { code };
}

// Follow merge links to the product that holds the stock.
export function resolveMaster(products, code) {
  let p = products[code];
  const seen = new Set();
  while (p && p.aliasOf && !seen.has(p.ean)) {
    seen.add(p.ean);
    p = products[p.aliasOf];
  }
  return p || null;
}

// Repeat guard for the live camera: a code counts again only after it was out of view.
export class RepeatGuard {
  constructor({ gapMs = 700, bounceMs = 350 } = {}) {
    this.gapMs = gapMs;
    this.bounceMs = bounceMs;
    this.lastSeen = new Map(); // code -> last time it was in view
    this.lastCount = null; // { code, t }
  }
  // source "camera": called on every decoded frame. "key": scanner/typed input.
  shouldCount(code, now, source = 'camera') {
    if (source !== 'camera') {
      const dup = this.lastCount && this.lastCount.code === code && now - this.lastCount.t < this.bounceMs;
      if (!dup) this.lastCount = { code, t: now };
      return !dup;
    }
    const prev = this.lastSeen.get(code);
    this.lastSeen.set(code, now);
    if (prev !== undefined && now - prev < this.gapMs) return false;
    this.lastCount = { code, t: now };
    return true;
  }
}

// Basket: scanned lines waiting to be booked together.
export function basketAdd(lines, code, n = 1) {
  const out = lines.map((l) => ({ ...l }));
  const l = out.find((x) => x.ean === code);
  if (l) l.qty += n;
  else out.unshift({ ean: code, qty: n });
  return out.filter((x) => x.qty > 0);
}
export function basketSet(lines, code, qty) {
  const q = Math.max(0, Math.floor(Number(qty) || 0));
  return lines.map((l) => (l.ean === code ? { ...l, qty: q } : { ...l })).filter((x) => x.qty > 0);
}
export function basketTotal(lines) {
  return lines.reduce((s, l) => s + l.qty, 0);
}
// For take-out: which lines need more than is in stock.
export function shortages(lines, products) {
  const res = [];
  for (const l of lines) {
    const p = resolveMaster(products, l.ean);
    const have = p ? p.qty || 0 : 0;
    if (l.qty > have) res.push({ ean: l.ean, want: l.qty, have });
  }
  return res;
}

// Quick, offline guess from OCR text. Claude Haiku replaces it later.
export function guessFromOcr(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 3);
  const clean = (s) => s.replace(/[|=©®™"“”]+/g, ' ').replace(/\s+/g, ' ').trim();
  let maker = '';
  for (const l of lines) {
    const m = l.match(/([A-ZÄÖÜ][\wÄÖÜäöüß&.\- ]{1,40}?\s(?:GmbH(?: & Co\. KG)?|AG|KG|Ltd\.?|Inc\.?|S\.?A\.?|B\.?V\.?|SE|Co\.))/);
    if (m) { maker = clean(m[1]); break; }
  }
  let model = '';
  const modelRe = /\b([A-Z]{1,5}[- ]?\d{3,}[A-Z0-9\-\/]*)\b/;
  for (const l of lines) {
    if (/www\.|https?:|\.pdf|^\d{5}\s+[A-ZÄÖÜ]/i.test(l)) continue;
    const m = l.match(modelRe);
    if (m) { model = m[1]; break; }
  }
  let name = '';
  let best = 0;
  for (const l of lines) {
    const c = clean(l);
    if (!c || c === model || (maker && c.includes(maker))) continue;
    if (/www\.|https?:|@|\.pdf|^\d{5}\s/i.test(c)) continue;
    const words = c.split(' ').filter((w) => /^[A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß\-]{2,}$/.test(w));
    const score = words.length * 3 + (/\d/.test(c) ? 1 : 0);
    if (score > best && words.length >= 1) { best = score; name = c.slice(0, 120); }
  }
  return { name, maker, model };
}

// OCR result good enough to hand Haiku as text? Otherwise send the photo.
export function ocrUsable(text, confidence) {
  const letters = (String(text || '').match(/[A-Za-zÄÖÜäöüß]/g) || []).length;
  return confidence >= 35 && letters >= 15;
}

// When to start a Haiku check: a full batch, or any item that OCR could not read.
export function shouldRunCheck(products, batchSize) {
  const list = Object.values(products).filter((p) => !p.aliasOf);
  const ready = list.filter((p) => p.status === 'ocr');
  const failed = list.filter((p) => p.status === 'error' && p.hasImage);
  if (failed.length > 0) return { run: true, reason: 'error', count: ready.length + failed.length };
  if (ready.length >= batchSize) return { run: true, reason: 'batch', count: ready.length };
  return { run: false, reason: '', count: ready.length };
}

// Sort text with empty values last ("~" sorts before letters in German collation).
export const cmpText = (a, b) => !a - !b || String(a || '').localeCompare(String(b || ''), 'de');

export function today(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export const STATUS_LABEL = {
  new: 'Liest Etikett…',
  ocr: 'Wartet auf Recherche',
  error: 'Etikett unlesbar',
  manual: 'Angaben fehlen',
  verified: 'Recherchiert',
  edited: 'Von dir bearbeitet',
};

export const CATEGORIES = [
  'Steckdose', 'Rahmen', 'Schalter', 'Taster', 'Wippe/Abdeckung', 'Dimmer', 'Bewegungsmelder', 'Leuchte', 'Leuchtmittel',
  'Netzteil/Treiber', 'Relais', 'Schütz', 'Leitungsschutzschalter', 'FI-Schutzschalter', 'Klemme', 'Kabel/Leitung',
  'Dose', 'Installationsmaterial', 'Kamera/Netzwerk', 'Werkzeug', 'Sonstiges',
];

// ---------- products without barcode ----------
const slug = (s) => String(s || '')
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toUpperCase().replace(/ß/g, 'SS').replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Own code for a product that has no barcode, e.g. "T-FINDER-4052". Unique within products.
export function makeTagCode({ maker, model, name, category }, products) {
  const parts = [slug(maker).split('-')[0], slug(model) || slug(name).split('-').slice(0, 3).join('-') || slug(category) || 'ARTIKEL'];
  const base = ('T-' + parts.filter(Boolean).join('-')).slice(0, 28).replace(/-+$/, '');
  let code = base;
  for (let i = 2; products[code]; i++) code = base + '-' + i;
  return code;
}
export const isTag = (code) => /^T-/.test(String(code));

// ---------- needs list ----------
// "20 Steckdosen ..." / "20x Rahmen" / "Rahmen 2-fach 8 Stk" -> { qty, text }
export function parseNeedText(raw) {
  let text = String(raw || '').trim().replace(/\s+/g, ' ');
  let qty = 1;
  let m = text.match(/^(\d+)\s*(?:x|×|stk\.?|stück|st\.?)?\s+(.+)$/i);
  if (m) { qty = Number(m[1]); text = m[2]; }
  else if ((m = text.match(/^(.+?)\s+(?:x\s*)?(\d+)\s*(?:x|×|stk\.?|stück|st\.?)$/i))) { qty = Number(m[2]); text = m[1]; }
  return { qty: Math.max(1, qty), text: text.trim() };
}

const SYN = [
  [/\b(doppelrahmen|zweifachrahmen|2-fach-rahmen)\b/g, '2-fach rahmen'],
  [/\b(einfachrahmen|1-fach-rahmen)\b/g, '1-fach rahmen'],
  [/\b(dreifachrahmen|3-fach-rahmen)\b/g, '3-fach rahmen'],
  [/\b(zweifach|doppelt?|2fach|2-fach|2 fach)\b/g, '2-fach'],
  [/\b(einfach|1fach|1-fach|1 fach)\b/g, '1-fach'],
  [/\b(dreifach|3fach|3-fach|3 fach)\b/g, '3-fach'],
  [/\b(vierfach|4fach|4-fach)\b/g, '4-fach'],
  [/\b(fünffach|5fach|5-fach)\b/g, '5-fach'],
  [/\bschuko\b/g, 'steckdose'],
  [/\bbusch[- ]?jaeger\b|\bbusch[- ]?jäger\b|\bbj\b/g, 'buschjaeger'],
];
export function tokens(s) {
  let t = String(s || '').toLowerCase();
  for (const [re, rep] of SYN) t = t.replace(re, rep);
  t = t.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  return t.split(/[^a-z0-9-]+/).filter((w) => w.length >= 2).map((w) => w.replace(/(en|n|e|s)$/, (x) => (w.length > 5 ? '' : x)));
}

// Best stock products for a free-text need line.
export function suggestProducts(text, products, limit = 3) {
  const want = [...new Set(tokens(text))];
  if (!want.length) return [];
  const res = [];
  for (const p of Object.values(products)) {
    if (p.aliasOf) continue;
    const hay = new Set(tokens([p.name, p.maker, p.series, p.category, p.variant, p.color, p.model, p.ean].join(' ')));
    let hit = 0;
    for (const w of want) if (hay.has(w) || [...hay].some((h) => h.length >= 4 && w.length >= 4 && (h.startsWith(w) || w.startsWith(h)))) hit++;
    if (!hit) continue;
    // Variant numbers must not contradict ("2-fach" asked, "1-fach" stocked).
    const fach = want.find((w) => /^\d-fach$/.test(w));
    if (fach && [...hay].some((h) => /^\d-fach$/.test(h) && h !== fach)) continue;
    res.push({ code: p.ean, score: hit / want.length, p });
  }
  return res.sort((a, b) => b.score - a.score || (b.p.qty || 0) - (a.p.qty || 0)).slice(0, limit);
}

// Stock is shared out to the lines in order, so two lines can't both count the same items.
// taken: { code: qty } already taken out for this list (its job); that counts as covered first.
export function computeNeed(lines, products, taken = {}) {
  const left = {};
  const done = {};
  for (const [code, q] of Object.entries(taken || {})) {
    const m = resolveMaster(products, code);
    const k = m ? m.ean : code;
    done[k] = (done[k] || 0) + q;
  }
  return lines.map((l) => {
    const p = l.code ? resolveMaster(products, l.code) : null;
    if (!p) return { ...l, taken: 0, fromStock: 0, have: 0, missing: l.qty, product: null };
    const t = Math.min(l.qty, done[p.ean] || 0);
    done[p.ean] = (done[p.ean] || 0) - t;
    if (left[p.ean] === undefined) left[p.ean] = Math.max(0, p.qty || 0);
    const fromStock = Math.min(l.qty - t, left[p.ean]);
    left[p.ean] -= fromStock;
    return { ...l, taken: t, fromStock, have: t + fromStock, missing: l.qty - t - fromStock, product: p };
  });
}

// What a needs list already got: items taken out by the jobs linked to it.
export function takenForNeed(needId, jobs) {
  const out = {};
  for (const j of Object.values(jobs || {})) {
    if (j.needId !== needId) continue;
    for (const [code, q] of Object.entries(j.items || {})) out[code] = (out[code] || 0) + q;
  }
  return out;
}

// What to order across all open needs lists, merged by product (or by text when unknown).
export function orderList(needs, products, jobs = {}) {
  const map = new Map();
  for (const n of needs) {
    if (n.closed) continue;
    for (const r of computeNeed(n.lines || [], products, takenForNeed(n.id, jobs))) {
      if (!r.missing) continue;
      const key = r.product ? r.product.ean : 'txt:' + r.text.toLowerCase();
      const cur = map.get(key) || { code: r.product?.ean || '', name: r.product?.name || r.text, maker: r.product?.maker || '', model: r.product?.model || '', qty: 0, needs: [] };
      cur.qty += r.missing;
      if (!cur.needs.includes(n.name)) cur.needs.push(n.name);
      map.set(key, cur);
    }
  }
  // Grouped by maker for ordering; lines without a maker (not in stock) at the end.
  return [...map.values()].sort((a, b) => !a.maker - !b.maker || (a.maker || '').localeCompare(b.maker || '') || a.name.localeCompare(b.name));
}

// Stock grouped for display: category -> products, with totals.
export function groupByCategory(list) {
  const groups = new Map();
  for (const p of list) {
    const c = p.category || 'Ohne Kategorie';
    if (!groups.has(c)) groups.set(c, { category: c, items: [], qty: 0 });
    const g = groups.get(c);
    g.items.push(p);
    g.qty += Math.max(0, p.qty || 0);
  }
  return [...groups.values()].sort((a, b) => (a.category === 'Ohne Kategorie') - (b.category === 'Ohne Kategorie') || a.category.localeCompare(b.category));
}
