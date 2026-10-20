// Claude Haiku agents: research new products, recognise products without barcode, match needs to stock.
import Anthropic from '@anthropic-ai/sdk';
import { CATEGORIES } from './logic.js';

export const MODEL = 'claude-haiku-5-5';
export const MAX_ITEMS_PER_CALL = 15;

function client(apiKey) {
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
}

// Compact catalog: short keys keep the prompt small even with thousands of products.
export function compactCatalog(products) {
  return Object.values(products)
    .filter((p) => !p.aliasOf)
    .slice(0, 3000)
    .map((p) => {
      const o = { c: p.ean, n: p.name || '' };
      if (p.maker) o.m = p.maker;
      if (p.series) o.s = p.series;
      if (p.category) o.k = p.category;
      if (p.variant) o.v = p.variant;
      if (p.model) o.a = p.model;
      o.q = p.qty || 0;
      return o;
    });
}
const CATALOG_KEYS = 'Catalog keys: c=code (EAN, or own tag code starting with T-), n=name, m=maker, s=series/line, k=category, v=variant, a=article/model number, q=in stock.';

const MAKER_HINT = `Most products in this stock are from Busch-Jaeger (ABB). Use what you know about Busch-Jaeger: article numbers like "1722-914" or "2006/1 UC-914", ABB order codes like "2CKA001725A1558", GTIN prefix 4011395, and series such as future linear, Busch-balance SI, Busch-axcent, solo, carat, Busch-dynasty, Reflex SI, Busch-free@home, Busch-Jaeger Smarter Home. Other makers do occur.`;

const FIELDS = `Fields (German values):
- name: short product name as a German electrician would write it, with the key specs, e.g. "SCHUKO-Steckdose mit Klappdeckel" or "LED-Netzteil 24 V DC 18 W IP20".
- maker: manufacturer, e.g. "Busch-Jaeger", "Gira", "EVN Lichttechnik".
- series: product line/design range if any, e.g. "future linear", "E2", "Busch-axcent"; else "".
- category: one of ${CATEGORIES.join(', ')}.
- variant: e.g. "1-fach", "2-fach", "3-fach", "16 A", "10 m"; else "".
- color: e.g. "studioweiß", "anthrazit"; else "".
- model: manufacturer article number, e.g. "1721-184K" or "SLK24018".
- description: one short German sentence with useful details.`;

async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}
const imageBlock = async (blob) => ({ type: 'image', source: { type: 'base64', media_type: blob.type || 'image/jpeg', data: await blobToBase64(blob) } });

function lastJson(content) {
  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Claude hat keine lesbare Antwort geliefert. Bitte nochmal versuchen.');
  try { return JSON.parse(text.slice(start, end + 1)); } catch { throw new Error('Claude hat keine lesbare Antwort geliefert. Bitte nochmal versuchen.'); }
}

function checkStop(res) {
  if (res.stop_reason === 'refusal') throw new Error('Claude hat diese Anfrage abgelehnt. Bitte von Hand ausfüllen.');
  if (res.stop_reason === 'max_tokens') throw new Error('Die Antwort war zu lang. Bitte kleinere Pakete einstellen.');
}

// ---------- research new products (with web search) ----------
const RESEARCH_SYSTEM = `You research products for the stock list of a German electrical installation company.
Each item was scanned by barcode (EAN). Some have text read from the label by OCR (may be noisy), some have a photo instead.
Use web search to look up each EAN (and the label text) to find the exact product, preferring the manufacturer's or a wholesaler's page. Keep searches short; one per product is usually enough.
${MAKER_HINT}
${FIELDS}
- confidence: high, medium or low.
- note: one short German sentence if a human should check something (e.g. EAN not found online, label EAN differs), else "".
- source: the URL you relied on, or "".
Never invent a product. If you cannot identify it, leave fields empty and explain in note.
Also list duplicates: pairs of different codes (new items and catalog) that are clearly the same product (same maker and article number).
Your final message must be only a JSON object: {"items":[{"ean","name","maker","series","category","variant","color","model","description","confidence","note","source","ean_on_label"}],"duplicates":[{"ean_a","ean_b","reason"}]}`;

export async function researchBatch({ apiKey, items, catalog }) {
  const c = client(apiKey);
  const textItems = items.filter((i) => !i.image).map((i) => ({ ean: i.ean, label_text: i.ocrText || '' }));
  const photoItems = items.filter((i) => i.image);
  const content = [{
    type: 'text',
    text: `${CATALOG_KEYS}\nExisting catalog:\n${JSON.stringify(catalog)}\n\nNew items:\n${JSON.stringify(textItems)}` +
      (photoItems.length ? `\n\nItems with a label photo (in this order): ${photoItems.map((i) => i.ean).join(', ')}` : ''),
  }];
  for (const i of photoItems) { content.push({ type: 'text', text: `Photo for EAN ${i.ean}:` }); content.push(await imageBlock(i.image)); }
  content.push({ type: 'text', text: `Return one entry in "items" for each of these EANs: ${items.map((i) => i.ean).join(', ')}.` });

  const base = { model: MODEL, max_tokens: 16000, system: RESEARCH_SYSTEM, output_config: { effort: 'low' } };
  const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: Math.min(10, items.length * 2) }];
  const messages = [{ role: 'user', content }];
  let res;
  try {
    res = await c.messages.create({ ...base, tools, messages });
    for (let i = 0; i < 4 && res.stop_reason === 'pause_turn'; i++) {
      res = await c.messages.create({ ...base, tools, messages: [messages[0], { role: 'assistant', content: res.content }] });
    }
  } catch (err) {
    // Web search not available for this key/model: research from the label text alone.
    if (err instanceof Anthropic.BadRequestError && /tool|web_search/i.test(err.message || '')) {
      try { res = await c.messages.create({ ...base, messages }); } catch (e2) { throw friendlyError(e2); }
    } else throw friendlyError(err);
  }
  checkStop(res);
  const data = lastJson(res.content);
  const searches = res.usage?.server_tool_use?.web_search_requests || 0;
  return { items: data.items || [], duplicates: data.duplicates || [], usage: res.usage, searches };
}

// ---------- recognise a product without barcode from a photo ----------
const IDENTIFY_SCHEMA = {
  type: 'object',
  properties: {
    match_code: { type: 'string' },
    match_confidence: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
    match_reason: { type: 'string' },
    name: { type: 'string' }, maker: { type: 'string' }, series: { type: 'string' }, category: { type: 'string' },
    variant: { type: 'string' }, color: { type: 'string' }, model: { type: 'string' }, description: { type: 'string' },
    read_text: { type: 'string' },
    barcode_digits: { type: 'string' },
  },
  required: ['match_code', 'match_confidence', 'match_reason', 'name', 'maker', 'series', 'category', 'variant', 'color', 'model', 'description', 'read_text', 'barcode_digits'],
  additionalProperties: false,
};

export async function identifyPhoto({ apiKey, image, hint, catalog }) {
  const c = client(apiKey);
  let res;
  try {
    res = await c.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: `You identify products for the stock list of a German electrical installation company from a photo. The product may have no barcode.
Read every ID, type number or text printed on it. Decide whether it is the same product as one in the existing catalog (same maker and type/article number, or clearly identical). Only match when you are sure it is the same article, not just the same kind.
${MAKER_HINT}
${FIELDS}
- match_code: the catalog code if it is the same product, else "".
- match_confidence: high, medium, low, or none when there is no match.
- match_reason: short German reason.
- read_text: the IDs and text you read from the product.
- barcode_digits: digits of an EAN barcode if one is visible, else "".`,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `${CATALOG_KEYS}\nExisting catalog:\n${JSON.stringify(catalog)}` },
          await imageBlock(image),
          { type: 'text', text: hint ? `Hint from the user: ${hint}` : 'Identify this product.' },
        ],
      }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: IDENTIFY_SCHEMA } },
    });
  } catch (err) { throw friendlyError(err); }
  checkStop(res);
  return lastJson(res.content);
}

// ---------- match free-text needs to stock ----------
const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: { line_id: { type: 'string' }, code: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, reason: { type: 'string' } },
        required: ['line_id', 'code', 'confidence', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['matches'],
  additionalProperties: false,
};

export async function matchNeedLines({ apiKey, lines, catalog }) {
  const c = client(apiKey);
  let res;
  try {
    res = await c.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: `You match lines of a German material needs list to products in a stock catalog of an electrical installation company.
For each line, return the catalog code of the product that fits it (same kind, same variant like 1-fach/2-fach, same series and color when the line says so). If several fit, prefer the one with stock. If nothing in the catalog fits, return code "" so it goes on the order list. reason: short German explanation.`,
      messages: [{ role: 'user', content: `${CATALOG_KEYS}\nCatalog:\n${JSON.stringify(catalog)}\n\nNeeds lines:\n${JSON.stringify(lines.map((l) => ({ line_id: l.id, text: l.text, qty: l.qty })))}` }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: MATCH_SCHEMA } },
    });
  } catch (err) { throw friendlyError(err); }
  checkStop(res);
  return lastJson(res.content).matches || [];
}

export function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) return new Error('API-Schlüssel wurde abgelehnt. Bitte in den Einstellungen prüfen.');
  if (err instanceof Anthropic.PermissionDeniedError) return new Error('Dieser API-Schlüssel darf Claude Haiku nicht nutzen. Bitte das Anthropic-Konto prüfen.');
  if (err instanceof Anthropic.RateLimitError) return new Error('Gerade zu viele Anfragen. Es wird später nochmal versucht.');
  if (err instanceof Anthropic.BadRequestError) return new Error('Claude hat die Anfrage abgelehnt: ' + (err.message || 'ungültig'));
  if (err instanceof Anthropic.APIConnectionError) return new Error('Keine Verbindung zu Claude. Es wird erneut versucht, sobald du online bist.');
  if (err instanceof Anthropic.APIError) return new Error('Claude-Fehler ' + (err.status || '') + ': ' + (err.message || ''));
  return err instanceof Error ? err : new Error(String(err));
}
