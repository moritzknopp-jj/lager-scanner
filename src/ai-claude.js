// Claude Haiku through the viewer's own Claude subscription (claude.ai artifact "sample" capability).
// Same functions as ai.js; no API key.
import { CATEGORIES } from './logic.js';

export const MODEL = 'claude-haiku-5-5';
export const MAX_ITEMS_PER_CALL = 10;
const OPTS = { model: MODEL, modelTier: 'quick', cache: false };

let sampleP = null;
const sample = () => (sampleP ||= Promise.resolve(window.claude?.use?.('sample') ?? null));

// What this view can do: text at all, and images (photos of labels and products).
export async function capabilities() {
  const s = await sample();
  if (!s) return { text: false, images: false, maxImages: 0, maxBytes: 0 };
  const lim = await s.limits().catch(() => null);
  return { text: !!lim, images: !!lim?.images, maxImages: lim?.images?.maxCount || 0, maxBytes: lim?.maxPromptBytes || 200000 };
}

// Compact catalog with short keys, cut to fit the prompt.
export function compactCatalog(products, budget = 140000) {
  const out = [];
  let size = 2;
  for (const p of Object.values(products)) {
    if (p.aliasOf) continue;
    const o = { c: p.ean, n: p.name || '' };
    if (p.maker) o.m = p.maker;
    if (p.series) o.s = p.series;
    if (p.category) o.k = p.category;
    if (p.variant) o.v = p.variant;
    if (p.model) o.a = p.model;
    o.q = p.qty || 0;
    const len = JSON.stringify(o).length + 1;
    if (size + len > budget) break;
    size += len;
    out.push(o);
  }
  return out;
}
const CATALOG_KEYS = 'Catalog keys: c=code (EAN, or own tag code starting with T-), n=name, m=maker, s=series/line, k=category, v=variant, a=article/model number, q=in stock.';

const MAKER_HINT = `Almost everything in this stock is from Busch-Jaeger (ABB). Look up Busch-Jaeger first (busch-jaeger.de), then ABB (new.abb.com): their article numbers are the cleanest IDs. Busch-Jaeger article numbers look like "1721-914", "1722-914" or "2006/1 UC-914"; ABB order codes look like "2CKA001725A1558"; Busch-Jaeger GTINs start with 4011395. In article numbers, 1721 = frame 1-fach, 1722 = 2-fach, 1723 = 3-fach, and the suffix is the design and colour (e.g. -914 = Busch-balance SI alpinweiß, -184K = future linear studioweiß).
Frames (Rahmen): always decide the design line. This company mainly uses Busch-balance SI and future linear. Busch-balance SI: glossy, gently domed surface, softly rounded outer edges and corners. future linear: flat surface with straight, crisp edges and nearly square corners. Others: Reflex SI (strongly rounded, thick), Busch-axcent (flat frame with wide border), solo, carat (glass/metal), Busch-dynasty. If you cannot tell, say so in note.
Other makers occur: lights and drivers (e.g. EVN, Easylux) usually carry the brand and article number on the label; cables are written like "NYM-J 3x1,5" or "J-Y(St)Y 2x2x0,8" and counted in metres.`;

const FIELDS = `Fields (German values):
- name: short product name as a German electrician would write it, with the key specs, e.g. "SCHUKO-Steckdose mit Klappdeckel" or "LED-Netzteil 24 V DC 18 W IP20".
- maker: manufacturer, e.g. "Busch-Jaeger", "Gira", "EVN Lichttechnik".
- series: product line/design range if any, e.g. "future linear", "E2"; else "".
- category: one of ${CATEGORIES.join(', ')}.
- variant: e.g. "1-fach", "2-fach", "16 A", "10 m"; else "".
- color: e.g. "studioweiß", "anthrazit"; else "".
- model: manufacturer article number, e.g. "1721-184K" or "SLK24018".
- description: one short German sentence with useful details.
- order_number: manufacturer order code (for ABB/Busch-Jaeger the 2CKA… code) if known, else "".
- all_ids: every number and ID you can read or know for this product, comma separated (EAN/GTIN, article number, order code, type numbers, other codes), so the stock list can be priced later.
- unit: "m" for cable/wire sold by the metre, else "Stück".`;

async function call(prompt, images) {
  const s = await sample();
  if (!s) throw new Error('Claude ist hier nicht verfügbar. Bitte die App in claude.ai öffnen und angemeldet sein.');
  try {
    return await s.json(prompt, { ...OPTS, ...(images && images.length ? { images } : {}) });
  } catch (e) {
    throw friendlyError(e);
  }
}

// ---------- research new products ----------
export async function researchBatch({ items, catalog }) {
  const caps = await capabilities();
  let photos = items.filter((i) => i.image);
  if (!caps.images) photos = [];
  photos = photos.slice(0, caps.maxImages || 0);
  const photoSet = new Set(photos.map((p) => p.ean));
  const textItems = items.filter((i) => !photoSet.has(i.ean)).map((i) => ({ ean: i.ean, label_text: i.ocrText || '' }));
  const prompt = `You identify products for the stock list of a German electrical installation company.
Each item was scanned by barcode (EAN). For some items you get a photo of the label or package (in this order: ${photos.map((p) => p.ean).join(', ') || 'none'}), for the others only the EAN.
Use what is printed in the photos and your own product knowledge (GS1 company prefixes, article numbers, product lines). Never invent a product: if you are not sure, leave fields empty and say so in note.
${MAKER_HINT}
${FIELDS}
- confidence: high, medium or low.
- note: one short German sentence if a human should check something, else "".
- ean_on_label: digits under the barcode if visible in the photo, else "".
Also list duplicates: pairs of different codes (new items and catalog) that are clearly the same product (same maker and article number).

${CATALOG_KEYS}
Existing catalog: ${JSON.stringify(catalog)}
Items with EAN only: ${JSON.stringify(textItems)}

Reply with only a JSON object: {"items":[{"ean","name","maker","series","category","variant","color","model","order_number","all_ids","unit","description","confidence","note","ean_on_label"}],"duplicates":[{"ean_a","ean_b","reason"}]}, one entry in "items" for each of these EANs: ${items.map((i) => i.ean).join(', ')}.`;
  const data = await call(prompt, photos.map((p) => p.image));
  return { items: Array.isArray(data?.items) ? data.items : [], duplicates: Array.isArray(data?.duplicates) ? data.duplicates : [], searches: 0 };
}

// ---------- recognise a product without barcode ----------
export async function identifyPhoto({ image, hint, catalog }) {
  const prompt = `You identify a product for the stock list of a German electrical installation company from the attached photo. The product may have no barcode.
Read every ID, type number or text printed on it. Decide whether it is the same product as one in the existing catalog (same maker and type/article number, or clearly identical). Only match when you are sure it is the same article, not just the same kind.
${MAKER_HINT}
${FIELDS}
- match_code: the catalog code if it is the same product, else "".
- match_confidence: high, medium, low, or none when there is no match.
- match_reason: short German reason.
- read_text: the IDs and text you read from the product.
- barcode_digits: digits of an EAN barcode if one is visible, else "".
- ean: the product's EAN/GTIN if visible or if you are certain of it, else "".
${hint ? `Hint from the user: ${hint}` : ''}

${CATALOG_KEYS}
Existing catalog: ${JSON.stringify(catalog)}

Reply with only a JSON object with the keys ${ID_KEYS.join(', ')}.`;
  return pick(await call(prompt, [image]));
}

const ID_KEYS = ['match_code', 'match_confidence', 'match_reason', 'name', 'maker', 'series', 'category', 'variant', 'color', 'model', 'order_number', 'all_ids', 'unit', 'description', 'read_text', 'barcode_digits', 'ean'];
const pick = (r) => Object.fromEntries(ID_KEYS.map((k) => [k, typeof r?.[k] === 'string' ? r[k] : '']));

// ---------- add a product by name ("Busch-Jaeger Schuko-Steckdose balance SI", "NYM-J 3x1,5") ----------
export async function lookupText({ text, catalog }) {
  const prompt = `The user of a German electrical installation company's stock list typed a product: "${text}".
Work out which product it is. If it is already in the catalog (same article), return its code in match_code. Otherwise describe the product, preferring the exact Busch-Jaeger article when the text fits one.
${MAKER_HINT}
${FIELDS}
- match_code / match_confidence (high, medium, low, none) / match_reason: as for a catalog match.
- ean: the product's EAN/GTIN only if you are certain of it (13 digits), else "".
- read_text and barcode_digits: "".

${CATALOG_KEYS}
Existing catalog: ${JSON.stringify(catalog)}

Reply with only a JSON object with the keys ${ID_KEYS.join(', ')}.`;
  return pick(await call(prompt));
}

// ---------- match free-text needs to stock ----------
export async function matchNeedLines({ lines, catalog }) {
  const prompt = `You match lines of a German material needs list to products in a stock catalog of an electrical installation company.
For each line, return the catalog code of the product that fits it (same kind, same variant like 1-fach/2-fach, same series and color when the line says so). If several fit, prefer the one with stock. If nothing fits, return code "" so it goes on the order list. reason: short German explanation.

${CATALOG_KEYS}
Catalog: ${JSON.stringify(catalog)}
Needs lines: ${JSON.stringify(lines.map((l) => ({ line_id: l.id, text: l.text, qty: l.qty })))}

Reply with only a JSON object: {"matches":[{"line_id","code","confidence":"high|medium|low","reason"}]}.`;
  const r = await call(prompt);
  return Array.isArray(r?.matches) ? r.matches : [];
}

export function friendlyError(e) {
  const code = e?.code;
  const msg = {
    not_granted: 'Claude-Zugriff wurde für diese App abgelehnt. Beim nächsten Öffnen der App fragt claude.ai erneut.',
    rate_limited: 'Claude-Nutzungslimit erreicht oder zu viele Anfragen auf einmal. Bitte später nochmal versuchen.',
    session_expired: 'Bitte bei claude.ai neu anmelden.',
    sampling_disabled: 'Claude ist für dieses Konto in Apps nicht freigeschaltet.',
    images_unavailable: 'Fotos an Claude senden geht in dieser Ansicht nicht.',
    image_rejected: 'Das Foto wurde nicht angenommen. Bitte ein anderes Foto (JPG/PNG) nehmen.',
    prompt_too_large: 'Zu viele Daten für eine Anfrage. Bitte kleinere Pakete einstellen.',
    refused: 'Claude hat diese Anfrage abgelehnt. Bitte von Hand ausfüllen.',
    invalid_json: 'Claude hat keine lesbare Antwort geliefert. Bitte nochmal versuchen.',
    empty_completion: 'Claude hat nichts geantwortet. Bitte nochmal versuchen.',
    upstream_error: 'Verbindung zu Claude unterbrochen. Bitte nochmal versuchen.',
  }[code];
  if (msg) return new Error(msg);
  return new Error('Claude-Fehler: ' + (e?.message || code || String(e)));
}
